/**
 * Encoder — Intent → bytes. docs/protocol.md §3. Proven by fixtures/tx.json.
 *
 * Every CC in an NRPN triple carries its own status byte (never running
 * status): the console latches the NRPN address, and an explicit status on
 * each message keeps the triple self-describing if anything downstream
 * re-splits the stream.
 */

import {
	colourByte,
	midiAddress,
	socketAddress,
	type ChannelRef,
	type ChannelType,
	type SocketRef,
} from './channels.js'
import {
	PARAM_ASSIGN,
	PARAM_FADER,
	PARAM_HPF_FREQ,
	PARAM_HPF_ON,
	PARAM_MAIN_ASSIGN,
	peqParamNumber,
	type Intent,
} from './intents.js'

export const SYSEX_HEADER = [0xf0, 0x00, 0x00, 0x1a, 0x50, 0x10, 0x01, 0x00] as const
export const SYSEX_END = 0xf7

export const MUTE_ON = 0x7f
export const MUTE_OFF = 0x3f

export const OP_GET_NAME = 0x01
export const OP_REPLY_NAME = 0x02
export const OP_SET_NAME = 0x03
export const OP_GET_COLOUR = 0x04
export const OP_REPLY_COLOUR = 0x05
export const OP_SET_COLOUR = 0x06
export const OP_PREAMP_PAD = 0x09
export const OP_PREAMP_48V = 0x0c
export const OP_SEND_LEVEL = 0x0d
export const OP_MIX_ASSIGN = 0x0e
export const OP_GET = 0x05

/** Get wrappers name the message type the reply comes back as (§3.13). */
export const GET_TYPE_NOTE = 0x09
export const GET_TYPE_CC = 0x0b
export const GET_TYPE_PITCHBEND = 0x0e
export const GET_TYPE_SYSEX = 0x0f

export const SCENE_COUNT = 500
export const CUE_LIST_COUNT = 2000 // ids 0..1999

function data7(value: number, what: string): number {
	if (!Number.isInteger(value) || value < 0 || value > 127) throw new RangeError(`${what} must be 0..127, got ${value}`)
	return value
}

function ref(i: { type: ChannelType; index: number }): ChannelRef {
	return { type: i.type, index: i.index }
}

function sock(i: { bank: SocketRef['bank']; socket: number }): number {
	return socketAddress({ bank: i.bank, socket: i.socket })
}

function sysex(n: number, body: number[]): number[] {
	return [...SYSEX_HEADER, n & 0x0f, ...body, SYSEX_END]
}

function nrpn(n: number, addr: number, param: number, value: number): number[] {
	const s = 0xb0 | (n & 0x0f)
	return [s, 0x63, addr, s, 0x62, param, s, 0x06, data7(value, 'NRPN value')]
}

function note(n: number, addr: number, on: boolean): number[] {
	return [0x90 | (n & 0x0f), addr, on ? MUTE_ON : MUTE_OFF]
}

/** 7-bit ASCII only: anything else becomes '?' so the SysEx grammar survives. */
export function nameBytes(name: string): number[] {
	const out: number[] = []
	for (const ch of name) {
		const c = ch.codePointAt(0) ?? 0x3f
		out.push(c < 0x80 ? c : 0x3f)
	}
	return out
}

export function sceneBytes(baseN: number, scene: number): number[] {
	if (!Number.isInteger(scene) || scene < 1 || scene > SCENE_COUNT) {
		throw new RangeError(`scene must be 1..${SCENE_COUNT}, got ${scene}`)
	}
	const idx = scene - 1
	const cc = 0xb0 | (baseN & 0x0f)
	const pc = 0xc0 | (baseN & 0x0f)
	return [cc, 0x00, Math.floor(idx / 128), cc, 0x20, 0x00, pc, idx % 128]
}

export function encode(baseN: number, intent: Intent): number[] {
	switch (intent.op) {
		case 'mute': {
			const { n, addr } = midiAddress(baseN, ref(intent))
			return note(n, addr, intent.on)
		}
		case 'fader': {
			const { n, addr } = midiAddress(baseN, ref(intent))
			return nrpn(n, addr, PARAM_FADER, intent.level)
		}
		case 'main_assign': {
			const { n, addr } = midiAddress(baseN, ref(intent))
			return nrpn(n, addr, PARAM_MAIN_ASSIGN, intent.on ? 0x7f : 0x3f)
		}
		case 'dca_assign': {
			if (!Number.isInteger(intent.dca) || intent.dca < 1 || intent.dca > 24) throw new RangeError(`DCA must be 1..24`)
			const { n, addr } = midiAddress(baseN, ref(intent))
			return nrpn(n, addr, PARAM_ASSIGN, (intent.on ? 0x40 : 0x00) + intent.dca - 1)
		}
		case 'mute_group_assign': {
			if (!Number.isInteger(intent.group) || intent.group < 1 || intent.group > 8)
				throw new RangeError(`mute group must be 1..8`)
			const { n, addr } = midiAddress(baseN, ref(intent))
			return nrpn(n, addr, PARAM_ASSIGN, (intent.on ? 0x58 : 0x18) + intent.group - 1)
		}
		case 'peq': {
			const { n, addr } = midiAddress(baseN, ref(intent))
			return nrpn(n, addr, peqParamNumber(intent.band, intent.param), intent.value)
		}
		case 'hpf_freq': {
			const { n, addr } = midiAddress(baseN, { type: 'input', index: intent.index })
			return nrpn(n, addr, PARAM_HPF_FREQ, intent.value)
		}
		case 'hpf_on': {
			const { n, addr } = midiAddress(baseN, { type: 'input', index: intent.index })
			return nrpn(n, addr, PARAM_HPF_ON, intent.on ? 0x40 : 0x00)
		}
		case 'scene':
			return sceneBytes(baseN, intent.scene)
		case 'cue_list': {
			if (!Number.isInteger(intent.id) || intent.id < 0 || intent.id >= CUE_LIST_COUNT) {
				throw new RangeError(`cue list id must be 0..${CUE_LIST_COUNT - 1}`)
			}
			const cc = 0xb0 | (baseN & 0x0f)
			const pc = 0xc0 | (baseN & 0x0f)
			return [cc, 0x00, Math.min(15, Math.floor(intent.id / 128)), pc, intent.id % 128]
		}
		case 'surface_cc':
		case 'action':
			return [0xb0 | (baseN & 0x0f), data7(intent.cc, 'control number'), data7(intent.value, 'control value')]
		case 'send_level': {
			const src = midiAddress(baseN, ref(intent))
			const dst = midiAddress(baseN, { type: intent.dest_type, index: intent.dest_index })
			return sysex(src.n, [OP_SEND_LEVEL, src.addr, dst.n, dst.addr, data7(intent.level, 'send level')])
		}
		case 'mix_assign': {
			const src = midiAddress(baseN, { type: 'input', index: intent.index })
			const dst = midiAddress(baseN, { type: intent.dest_type, index: intent.dest_index })
			return sysex(src.n, [OP_MIX_ASSIGN, src.addr, dst.n, dst.addr, intent.on ? 0x40 : 0x00])
		}
		case 'preamp_gain':
			return [0xe0 | (baseN & 0x0f), sock(intent), data7(intent.value, 'preamp gain')]
		case 'preamp_pad':
			return sysex(baseN, [OP_PREAMP_PAD, sock(intent), intent.on ? 0x40 : 0x00])
		case 'preamp_48v':
			return sysex(baseN, [OP_PREAMP_48V, sock(intent), intent.on ? 0x40 : 0x00])
		case 'get_name': {
			const { n, addr } = midiAddress(baseN, ref(intent))
			return sysex(n, [OP_GET_NAME, addr])
		}
		case 'set_name': {
			const { n, addr } = midiAddress(baseN, ref(intent))
			return sysex(n, [OP_SET_NAME, addr, ...nameBytes(intent.name)])
		}
		case 'get_colour': {
			const { n, addr } = midiAddress(baseN, ref(intent))
			return sysex(n, [OP_GET_COLOUR, addr])
		}
		case 'set_colour': {
			const { n, addr } = midiAddress(baseN, ref(intent))
			return sysex(n, [OP_SET_COLOUR, addr, colourByte(intent.colour)])
		}
		case 'ufx_key':
			return [0xb0 | (baseN & 0x0f), 0x0c, data7(intent.key, 'key')]
		case 'ufx_scale':
			return [0xb0 | (baseN & 0x0f), 0x0d, data7(intent.scale, 'scale')]
		case 'get_mute': {
			const { n, addr } = midiAddress(baseN, ref(intent))
			return sysex(n, [OP_GET, GET_TYPE_NOTE, addr])
		}
		case 'get_fader': {
			const { n, addr } = midiAddress(baseN, ref(intent))
			return sysex(n, [OP_GET, GET_TYPE_CC, PARAM_FADER, addr])
		}
		case 'get_param': {
			const { n, addr } = midiAddress(baseN, ref(intent))
			return sysex(n, [OP_GET, GET_TYPE_CC, data7(intent.param, 'param'), addr])
		}
		case 'get_send_level': {
			const src = midiAddress(baseN, ref(intent))
			const dst = midiAddress(baseN, { type: intent.dest_type, index: intent.dest_index })
			return sysex(src.n, [OP_GET, GET_TYPE_SYSEX, OP_SEND_LEVEL, src.addr, dst.n, dst.addr])
		}
		case 'get_mix_assign': {
			const src = midiAddress(baseN, { type: 'input', index: intent.index })
			const dst = midiAddress(baseN, { type: intent.dest_type, index: intent.dest_index })
			return sysex(src.n, [OP_GET, GET_TYPE_SYSEX, OP_MIX_ASSIGN, src.addr, dst.n, dst.addr])
		}
		case 'get_preamp_gain':
			return sysex(baseN, [OP_GET, GET_TYPE_PITCHBEND, sock(intent)])
		case 'get_preamp_pad':
			return sysex(baseN, [OP_GET, GET_TYPE_SYSEX, OP_PREAMP_PAD, sock(intent)])
		case 'get_preamp_48v':
			return sysex(baseN, [OP_GET, GET_TYPE_SYSEX, OP_PREAMP_48V, sock(intent)])
		default: {
			const never: never = intent
			throw new Error(`unhandled intent ${JSON.stringify(never)}`)
		}
	}
}

export function toHex(bytes: ArrayLike<number>): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ')
}

export function fromHex(hex: string): number[] {
	const trimmed = hex.trim()
	if (!trimmed) return []
	return trimmed.split(/\s+/).map((h) => {
		const v = Number.parseInt(h, 16)
		if (Number.isNaN(v) || v < 0 || v > 255) throw new RangeError(`bad hex byte ${h}`)
		return v
	})
}
