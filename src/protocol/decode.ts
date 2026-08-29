/**
 * Decoder — byte stream → ConsoleEvents. docs/protocol.md §4–5. Proven by
 * fixtures/rx.json.
 *
 * TCP hands us arbitrary chunks, so this is a byte-at-a-time state machine
 * with two layers: a raw MIDI parser (running status, real-time bytes
 * anywhere, SysEx across chunks, bounded accumulator) and a semantic layer
 * on top that owns the NRPN latch and turns a lone `63` into a fader ping.
 *
 * The decoder is pure: no timers. A lone ping only becomes visible when the
 * next message arrives or when `flush()` is called — the transport calls
 * flush() a few milliseconds after each chunk so a ping never waits on the
 * next unrelated message.
 */

import { colourFromByte, resolveAddress, resolveSocket, type ChannelRef } from './channels.js'
import {
	OP_MIX_ASSIGN,
	OP_PREAMP_48V,
	OP_PREAMP_PAD,
	OP_REPLY_PREAMP_48V,
	OP_REPLY_PREAMP_PAD,
	OP_REPLY_COLOUR,
	OP_REPLY_NAME,
	OP_SEND_LEVEL,
	SYSEX_HEADER,
} from './encode.js'
import { PARAM_FADER, type ConsoleEvent } from './intents.js'

const VOICE_LEN: Record<number, number> = { 0x80: 2, 0x90: 2, 0xa0: 2, 0xb0: 2, 0xc0: 1, 0xd0: 1, 0xe0: 2 }
const COMMON_LEN: Record<number, number> = { 0xf1: 1, 0xf2: 2, 0xf3: 1, 0xf6: 0 }
export const SYSEX_MAX = 256

interface RawMessage {
	status: number
	data: number[]
}

/** Raw MIDI layer: bytes → complete messages. Independent of dLive. */
export class MidiParser {
	private status: number | null = null
	private running: number | null = null
	private need = 0
	private data: number[] = []
	private sysex: number[] | null = null
	/** count of SysEx messages dropped for exceeding SYSEX_MAX */
	public sysexOverruns = 0

	feed(chunk: ArrayLike<number>, out: RawMessage[]): void {
		for (let i = 0; i < chunk.length; i++) this.byte(chunk[i], out)
	}

	private byte(b: number, out: RawMessage[]): void {
		if (b >= 0xf8) return // system real-time: dropped, disturbs nothing

		if (this.sysex !== null) {
			if (b === 0xf7) {
				out.push({ status: 0xf0, data: this.sysex })
				this.sysex = null
				return
			}
			if (b >= 0x80) {
				// a status byte aborts an unterminated SysEx; reprocess it
				this.sysex = null
				this.byte(b, out)
				return
			}
			if (this.sysex.length >= SYSEX_MAX) {
				this.sysexOverruns++
				this.sysex = null // drop it; the stream continues
				return
			}
			this.sysex.push(b)
			return
		}

		if (b === 0xf0) {
			this.sysex = []
			this.status = null
			this.running = null
			this.need = 0
			this.data = []
			return
		}

		if (b >= 0x80) {
			const hi = b & 0xf0
			if (hi in VOICE_LEN) {
				this.status = b
				this.running = b
				this.need = VOICE_LEN[hi]
				this.data = []
			} else {
				this.status = b
				this.running = null
				this.need = COMMON_LEN[b] ?? 0
				this.data = []
				if (this.need === 0) this.emit(out)
			}
			return
		}

		// data byte
		if (this.status === null) {
			if (this.running === null) return // stray data byte with no context
			this.status = this.running
			this.need = VOICE_LEN[this.running & 0xf0]
			this.data = []
		}
		this.data.push(b)
		if (this.data.length >= this.need) this.emit(out)
	}

	private emit(out: RawMessage[]): void {
		if (this.status === null) return
		const hi = this.status & 0xf0
		out.push({ status: this.status, data: this.data })
		if (hi in VOICE_LEN) {
			// re-arm for running status on the same status byte
			this.status = null
			this.need = VOICE_LEN[hi]
		} else {
			this.status = null
			this.need = 0
		}
		this.data = []
	}
}

interface NrpnLatch {
	msb: number | null
	lsb: number | null
}

export class DliveDecoder {
	private readonly parser = new MidiParser()
	private readonly latch: NrpnLatch[] = Array.from({ length: 16 }, () => ({ msb: null, lsb: null }))
	private readonly bank: number[] = new Array<number>(16).fill(0)
	/** a `63` that has not yet been followed by `62` — a fader ping in waiting */
	private pendingPing: { n: number; addr: number } | null = null

	constructor(public baseN: number) {}

	get sysexOverruns(): number {
		return this.parser.sysexOverruns
	}

	feed(chunk: ArrayLike<number>): ConsoleEvent[] {
		const raw: RawMessage[] = []
		this.parser.feed(chunk, raw)
		const out: ConsoleEvent[] = []
		for (const m of raw) this.message(m, out)
		return out
	}

	/** Emit any pending fader ping. Call when the stream goes quiet. */
	flush(): ConsoleEvent[] {
		const out: ConsoleEvent[] = []
		this.flushPing(out)
		return out
	}

	private flushPing(out: ConsoleEvent[]): void {
		if (!this.pendingPing) return
		const ref = resolveAddress(this.baseN, this.pendingPing.n, this.pendingPing.addr)
		this.pendingPing = null
		if (ref) out.push({ kind: 'fader_ping', ...ref })
	}

	private message(m: RawMessage, out: ConsoleEvent[]): void {
		const hi = m.status & 0xf0
		const n = m.status & 0x0f

		if (m.status === 0xf0) {
			if (!isAhSysex(m.data)) return // foreign SysEx: ignored, transparent to a pending ping
			this.flushPing(out)
			this.sysex(m.data, out)
			return
		}
		if (hi === 0xb0) {
			this.cc(n, m.data[0], m.data[1], out)
			return
		}
		if (hi === 0x80) return // note off: ignored, transparent to a pending ping
		// A Note On with velocity 0 is the same message in MIDI's
		// running-status idiom, and it is how the console writes the
		// terminator of its own mute pair ("9N CH 7F, [9N] CH 00",
		// spec p.2). The spec's receive table is explicit — "Velocity
		// 00 and NOTE OFF messages are ignored", OFF starting at 0x01 —
		// so reading it as a mute-off would make every mute-on from the
		// surface arrive as on-then-immediately-off.
		if (hi === 0x90 && m.data[1] === 0) return
		this.flushPing(out)
		switch (hi) {
			case 0x90: {
				const ref = resolveAddress(this.baseN, n, m.data[0])
				if (ref) out.push({ kind: 'mute', ...ref, on: m.data[1] >= 0x40 })
				else out.push({ kind: 'unknown', status: m.status, data: [...m.data] })
				return
			}
			case 0xc0: {
				const offset = (n - this.baseN + 16) & 0x0f
				if (offset > 4) {
					out.push({ kind: 'unknown', status: m.status, data: [...m.data] })
					return
				}
				out.push({ kind: 'scene', scene: this.bank[n] * 128 + m.data[0] + 1 })
				return
			}
			case 0xe0: {
				if (n !== (this.baseN & 0x0f)) {
					out.push({ kind: 'unknown', status: m.status, data: [...m.data] })
					return
				}
				const sock = resolveSocket(m.data[0])
				if (sock) out.push({ kind: 'preamp_gain', ...sock, value: m.data[1] })
				return
			}
			default:
				if (hi < 0xf0) out.push({ kind: 'unknown', status: m.status, data: [...m.data] })
		}
	}

	private cc(n: number, cc: number, value: number, out: ConsoleEvent[]): void {
		const offset = (n - this.baseN + 16) & 0x0f
		if (offset > 4) {
			this.flushPing(out)
			out.push({ kind: 'unknown', status: 0xb0 | n, data: [cc, value] })
			return
		}
		const latch = this.latch[n]
		switch (cc) {
			case 0x63: // NRPN MSB = channel address
				this.flushPing(out)
				latch.msb = value
				latch.lsb = null
				this.pendingPing = { n, addr: value }
				return
			case 0x62: // NRPN LSB = parameter
				if (this.pendingPing && this.pendingPing.n === n) this.pendingPing = null
				else this.flushPing(out)
				latch.lsb = value
				return
			case 0x06: {
				// Data Entry MSB
				if (this.pendingPing && this.pendingPing.n === n) this.pendingPing = null
				else this.flushPing(out)
				if (latch.msb === null || latch.lsb === null) return
				const ref = resolveAddress(this.baseN, n, latch.msb)
				if (!ref) return
				this.param(ref, latch.lsb, value, out)
				return
			}
			case 0x00: // Bank Select MSB
				this.flushPing(out)
				this.bank[n] = value
				return
			case 0x20: // Bank Select LSB: ignored (always 0)
				this.flushPing(out)
				return
			default:
				if (cc >= 0x78) return // channel mode: ignored, never touches the latch or a pending ping
				this.flushPing(out)
				// any other CC on a known channel (Actions echo, UFX, Go/Next/Prev) — not state
				return
		}
	}

	private param(ref: ChannelRef, param: number, value: number, out: ConsoleEvent[]): void {
		if (param === PARAM_FADER) out.push({ kind: 'fader', ...ref, level: value })
		else out.push({ kind: 'param', ...ref, param, value })
	}

	private sysex(body: number[], out: ConsoleEvent[]): void {
		// body excludes F0/F7. A&H header is 7 bytes after F0.
		const p = body.slice(SYSEX_HEADER.length - 1)
		if (p.length < 2) return
		const n = p[0] & 0x0f
		const op = p[1]
		switch (op) {
			case OP_REPLY_NAME: {
				const ref = resolveAddress(this.baseN, n, p[2])
				if (!ref) return
				const name = decodeName(p.slice(3))
				out.push({ kind: 'name', ...ref, name })
				return
			}
			case OP_REPLY_COLOUR: {
				const ref = resolveAddress(this.baseN, n, p[2])
				if (!ref || p.length < 4) return
				out.push({ kind: 'colour', ...ref, colour: colourFromByte(p[3]) })
				return
			}
			case OP_SEND_LEVEL: {
				if (p.length < 6) return
				const src = resolveAddress(this.baseN, n, p[2])
				const dst = resolveAddress(this.baseN, p[3] & 0x0f, p[4])
				if (!src || !dst) return
				out.push({ kind: 'send_level', ...src, dest_type: dst.type, dest_index: dst.index, level: p[5] })
				return
			}
			case OP_MIX_ASSIGN: {
				if (p.length < 6) return
				const src = resolveAddress(this.baseN, n, p[2])
				const dst = resolveAddress(this.baseN, p[3] & 0x0f, p[4])
				if (!src || src.type !== 'input' || !dst) return
				out.push({ kind: 'mix_assign', index: src.index, dest_type: dst.type, dest_index: dst.index, on: p[5] >= 0x40 })
				return
			}
			// The spec gives pad and 48 V dedicated REPLY ops (08 / 0B)
			// distinct from their set ops (09 / 0C). Accept both: the
			// reply op is what the PDF documents, the set op is what a
			// pure echo would look like, and which one the console
			// actually emits is a capture item.
			case OP_REPLY_PREAMP_PAD:
			case OP_REPLY_PREAMP_48V:
			case OP_PREAMP_PAD:
			case OP_PREAMP_48V: {
				if (p.length < 4) return
				const sock = resolveSocket(p[2])
				if (!sock) return
				const isPad = op === OP_PREAMP_PAD || op === OP_REPLY_PREAMP_PAD
				out.push({ kind: isPad ? 'preamp_pad' : 'preamp_48v', ...sock, on: p[3] >= 0x40 })
				return
			}
			default:
				return // unknown A&H op (including echoed sets/gets): ignored
		}
	}
}

function isAhSysex(body: number[]): boolean {
	for (let i = 1; i < SYSEX_HEADER.length; i++) {
		if (body[i - 1] !== SYSEX_HEADER[i]) return false
	}
	return true
}

export function decodeName(bytes: number[]): string {
	let s = ''
	for (const b of bytes) {
		if (b === 0) break
		s += b < 0x80 ? String.fromCharCode(b) : '�'
	}
	return s.trim()
}
