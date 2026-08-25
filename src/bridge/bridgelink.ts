/**
 * BridgeLink — the module as a MIDI Bridge lane (Client API v1).
 *
 * Spec: monorepo docs/bridge-client-api-v1.md; wire shapes pinned by
 * fixtures/api/exchanges.json (authored bridge-side, vendored here).
 *
 * Division of labour versus direct mode: the bridge owns the console
 * socket, the state mirror, query-on-ping, the heartbeat and timed
 * fades. This side is deliberately thin — hello, one snapshot, an SSE
 * delta stream mapped into the same ConsoleState the feedbacks already
 * read, and commands posted as fixture-contract intents. Ops the API
 * does not encode first-class ride `{"op":"raw"}` using the module's
 * own encoder, so the full action set keeps working.
 *
 * v1.1 feedback coverage via the bridge mirror: mutes, faders, names,
 * colours, scene, connection. The param family (assigns, HPF, preamp,
 * sends) has no mirror paths yet — those feedbacks stay at their
 * optimistic/local values in bridge mode and `diag().unsupported`
 * says so.
 */

import { EventEmitter } from 'node:events'
import { CHANNEL_TABLE, isChannelType, type ChannelRef, type Colour } from '../protocol/channels.js'
import { encode, toHex } from '../protocol/encode.js'
import { intentSocket, type ConsoleEvent, type Intent } from '../protocol/intents.js'
import { ConsoleState, CONNECTION_PATH } from '../state/model.js'
import { SubscriptionRegistry } from '../state/subscriptions.js'
import type { LinkApi, LinkDiag, LinkEvents, LinkStatus } from '../link-api.js'
import { localEvent, type SyncScope } from '../link.js'

/** Ops the shipped v1.1 bridge encodes first-class (everything else → raw). */
const FIRST_CLASS = new Set([
	'mute',
	'fader',
	'scene',
	'set_name',
	'set_colour',
	'get_name',
	'get_colour',
	'get_mute',
	'get_fader',
])

/**
 * Capability-gated ops are sent verbatim, NEVER wrapped in `raw`: the raw
 * escape hatch would silently bypass the bridge's gate (send_level is
 * gated until the calibration session), and the polite `capability_off`
 * ack is the behaviour we want.
 */
const GATED = new Set(['send_level'])

export interface BridgeLinkOptions {
	host: string
	port: number
	token?: string
	laneName: string
	/** used only until /info reports the bridge's own base channel */
	baseChannel: number
	retryMs?: number
	now?: () => number
}

interface BridgeCaps {
	fade?: boolean
	raw?: boolean
	send_level?: boolean
}

export class BridgeLink extends EventEmitter<LinkEvents> implements LinkApi {
	readonly state = new ConsoleState()
	readonly subscriptions = new SubscriptionRegistry()
	private _status: LinkStatus = 'disconnected'
	private _statusMessage: string | undefined
	private started = false
	private laneId: string | null = null
	private caps: BridgeCaps = {}
	private baseN: number
	/** the bridge's own base channel, adopted from /info */
	public bridgeBaseChannel: number | undefined
	private consoleState: string | undefined
	private seq = -1
	private cidCounter = 0
	private streamAbort: AbortController | null = null
	private retryTimer: NodeJS.Timeout | null = null
	private generation = 0
	private unsupportedOps = new Set<string>()
	public stats = { cmdsSent: 0, cmdsFailed: 0, deltas: 0, resyncs: 0 }

	constructor(private readonly opts: BridgeLinkOptions) {
		super()
		this.baseN = (opts.baseChannel - 1) & 0x0f
	}

	// ------------------------------------------------------------ LinkApi

	get status(): LinkStatus {
		return this._status
	}

	get statusMessage(): string | undefined {
		return this._statusMessage
	}

	get isOk(): boolean {
		return this._status === 'ok'
	}

	start(): void {
		if (this.started) return
		this.started = true
		this.setStatus('connecting', `Waiting for MIDI Bridge at ${this.opts.host}:${this.opts.port}`)
		void this.runSession(++this.generation)
	}

	stop(): void {
		this.started = false
		this.generation++
		if (this.retryTimer) clearTimeout(this.retryTimer)
		this.retryTimer = null
		this.streamAbort?.abort()
		this.streamAbort = null
		if (this.laneId) {
			// best-effort clean detach
			void this.http('DELETE', `/api/v1/lane/${this.laneId}`).catch(() => undefined)
			this.laneId = null
		}
		this.setStatus('disconnected', undefined)
	}

	setBaseChannel(_baseChannel: number): void {
		// The bridge owns the base channel; /info tells us. Nothing to do.
	}

	send(intent: Intent): boolean {
		if (!this.laneId) {
			this.emit('log', 'debug', `Bridge lane not up; dropped ${intent.op}`)
			return false
		}
		void this.postIntent(intent)
		const local = localEvent(intent)
		if (local) {
			const changed = this.state.apply(local)
			if (changed.length) this.emit('changed', changed)
		}
		return true
	}

	query(intent: Intent, _path: string, _priority?: 'high' | 'normal' | 'low'): void {
		if (!this.laneId) return
		if (FIRST_CLASS.has(intent.op)) {
			void this.postIntent(intent)
			return
		}
		// The mirror has no paths for the param family in v1 — a Get would
		// have nowhere to land. Record it as unsupported instead of asking.
		if (!this.unsupportedOps.has(intent.op)) {
			this.unsupportedOps.add(intent.op)
			this.emit(
				'log',
				'info',
				`${intent.op}: no bridge mirror support in API v1 — feedback for it stays local in bridge mode`,
			)
		}
	}

	fadeTo(ref: ChannelRef, toLv: number, durationMs: number): void {
		if (durationMs <= 0 || this.caps.fade === false) {
			this.send({ op: 'fader', type: ref.type, index: ref.index, level: toLv })
			return
		}
		void this.postCmd({ op: 'fade', type: ref.type, index: ref.index, to_lv: toLv, over_ms: Math.round(durationMs) })
	}

	fadeSend(src: ChannelRef, dst: ChannelRef, _fromLv: number, toLv: number, _durationMs: number): void {
		// Sends are capability-gated until calibration; a ramp would be
		// rejected step by step. Send the target once; the ack reports the gate.
		this.send({
			op: 'send_level',
			type: src.type,
			index: src.index,
			dest_type: dst.type,
			dest_index: dst.index,
			level: toLv,
		})
	}

	sync(_scope: SyncScope): void {
		void this.refetchState('resync requested')
	}

	diag(): LinkDiag {
		return {
			getsInFlight: 0,
			getsMissed: this.stats.cmdsFailed,
			unsupported: [...this.unsupportedOps].join(', '),
		}
	}

	// ------------------------------------------------------------ HTTP plumbing

	private baseUrl(): string {
		return `http://${this.opts.host}:${this.opts.port}`
	}

	private headers(): Record<string, string> {
		const h: Record<string, string> = { 'Content-Type': 'application/json' }
		if (this.opts.token) h.Authorization = `Bearer ${this.opts.token}`
		return h
	}

	private async http(
		method: string,
		path: string,
		body?: unknown,
	): Promise<{ status: number; json: Record<string, unknown> }> {
		const res = await fetch(this.baseUrl() + path, {
			method,
			headers: this.headers(),
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(5000),
		})
		let json: Record<string, unknown> = {}
		try {
			json = (await res.json()) as Record<string, unknown>
		} catch {
			/* non-JSON body */
		}
		return { status: res.status, json }
	}

	private nextCid(): string {
		return `c${++this.cidCounter}`
	}

	private async postCmd(intentObj: Record<string, unknown>): Promise<void> {
		const cid = this.nextCid()
		try {
			const { status, json } = await this.http('POST', '/api/v1/cmd', {
				v: 1,
				session: 'main',
				lane_id: this.laneId,
				cid,
				intent: intentObj,
			})
			this.stats.cmdsSent++
			if (status === 401) {
				// lane reaped — re-hello and retry once
				this.emit('log', 'debug', 'Bridge lane expired; re-registering')
				await this.hello()
				await this.http('POST', '/api/v1/cmd', { v: 1, session: 'main', lane_id: this.laneId, cid, intent: intentObj })
				return
			}
			if (json.ok === false) {
				this.stats.cmdsFailed++
				const err = (json.error ?? {}) as { code?: string; message?: string }
				const level = err.code === 'capability_off' || err.code === 'unsupported_op' ? 'info' : 'warn'
				this.emit(
					'log',
					level,
					`Bridge rejected ${String(intentObj.op)}: ${err.code ?? status}${err.message ? ` (${err.message})` : ''}`,
				)
			}
		} catch (e) {
			this.stats.cmdsFailed++
			this.emit('log', 'debug', `cmd ${String(intentObj.op)} failed: ${(e as Error).message}`)
		}
	}

	private async postIntent(intent: Intent): Promise<void> {
		if (FIRST_CLASS.has(intent.op) || GATED.has(intent.op)) {
			await this.postCmd(intent)
			return
		}
		// Module-side encoding, bridge-side transmission: op "raw".
		let bytes: number[]
		try {
			bytes = encode(this.baseN, intent)
		} catch (e) {
			this.emit('log', 'warn', `Refusing to send ${intent.op}: ${(e as Error).message}`)
			return
		}
		if (intentSocket(intent) === 'surface' && !this.unsupportedOps.has('surface_socket')) {
			this.unsupportedOps.add('surface_socket')
			this.emit(
				'log',
				'info',
				'Surface-role messages ride the bridge’s MixRack socket (the bridge has one console connection)',
			)
		}
		await this.postCmd({ op: 'raw', hex: toHex(bytes) })
	}

	// ------------------------------------------------------------ session

	private async runSession(gen: number): Promise<void> {
		while (this.started && gen === this.generation) {
			try {
				await this.connectOnce(gen)
			} catch (e) {
				if (!this.started || gen !== this.generation) return
				this.laneId = null
				this.setStatus(
					'connecting',
					`Waiting for MIDI Bridge at ${this.opts.host}:${this.opts.port} (${(e as Error).message})`,
				)
			}
			if (!this.started || gen !== this.generation) return
			await new Promise((r) => (this.retryTimer = setTimeout(r, this.opts.retryMs ?? 2000)))
		}
	}

	private async connectOnce(gen: number): Promise<void> {
		// 1. info: adopt the bridge's base channel + capabilities
		const info = await this.http('GET', '/api/v1/info')
		if (info.status !== 200) throw new Error(`info ${info.status}`)
		const base = Number(info.json.base_channel)
		if (Number.isInteger(base) && base >= 1 && base <= 16) {
			this.bridgeBaseChannel = base
			this.baseN = (base - 1) & 0x0f
		}
		this.caps = info.json.capabilities ?? {}

		// 2. hello
		await this.hello()

		// 3. snapshot, then stream from its seq
		await this.refetchState('connect')
		this.applyConsoleState()

		// 4. stream (returns on drop; throws on resync/other errors)
		await this.consumeStream(gen)
		throw new Error('stream closed')
	}

	private async hello(): Promise<void> {
		const res = await this.http('POST', '/api/v1/hello', {
			v: 1,
			session: 'main',
			name: this.opts.laneName,
			kind: 'companion',
		})
		if (res.status !== 200) throw new Error(`hello ${res.status}`)
		this.laneId = String(res.json.lane_id)
	}

	private async refetchState(why: string): Promise<void> {
		const res = await this.http('GET', '/api/v1/state')
		if (res.status !== 200) throw new Error(`state ${res.status}`)
		this.seq = Number(res.json.seq ?? -1)
		const snapshot = (res.json.state ?? {}) as Record<string, unknown>
		const changed: string[] = []
		for (const [path, value] of Object.entries(snapshot)) {
			if (path === 'connection.console') {
				this.consoleState = String(value)
				continue
			}
			const ev = deltaToEvent(path, value)
			if (!ev) continue
			for (const p of this.state.apply(ev)) changed.push(p)
		}
		if (changed.length) this.emit('changed', changed)
		this.emit('log', 'debug', `mirror snapshot: ${Object.keys(snapshot).length} paths (${why})`)
	}

	private applyConsoleState(): void {
		const console_ = this.consoleState ?? 'connected'
		if (console_ === 'connected') {
			if (this._status !== 'ok') {
				this.state.connected = true
				this.setStatus('ok', undefined)
				this.emit('changed', [CONNECTION_PATH])
			}
		} else {
			const wasOk = this._status === 'ok'
			this.setStatus('failure', `MIDI Bridge is running but its console link is ${console_} — check the bridge app`)
			if (wasOk) {
				this.state.connected = false
				this.emit('changed', [CONNECTION_PATH])
			}
		}
	}

	private async consumeStream(gen: number): Promise<void> {
		const abort = new AbortController()
		this.streamAbort = abort
		const res = await fetch(`${this.baseUrl()}/api/v1/stream`, {
			headers: { ...this.headers(), 'Last-Event-ID': String(this.seq) },
			signal: abort.signal,
		})
		if (res.status === 409) {
			this.stats.resyncs++
			await this.refetchState('event ring resync')
			this.applyConsoleState()
			throw new Error('resync')
		}
		if (res.status !== 200 || !res.body) throw new Error(`stream ${res.status}`)

		const reader = res.body.getReader()
		const decoder = new TextDecoder()
		let buf = ''
		for (;;) {
			const { value, done } = await reader.read()
			if (done || !this.started || gen !== this.generation) return
			buf += decoder.decode(value, { stream: true })
			let idx: number
			while ((idx = buf.indexOf('\n\n')) >= 0) {
				const frame = buf.slice(0, idx)
				buf = buf.slice(idx + 2)
				this.handleFrame(frame)
			}
		}
	}

	private handleFrame(frame: string): void {
		let kind = 'message'
		let data = ''
		let id: string | undefined
		for (const line of frame.split('\n')) {
			if (line.startsWith('event:')) kind = line.slice(6).trim()
			else if (line.startsWith('data:')) data += line.slice(5).trim()
			else if (line.startsWith('id:')) id = line.slice(3).trim()
		}
		if (id !== undefined && id !== '') this.seq = Number(id)
		if (!data) return
		let payload: Record<string, unknown>
		try {
			payload = JSON.parse(data) as Record<string, unknown>
		} catch {
			return
		}
		this.handleEvent(kind, payload)
	}

	private handleEvent(kind: string, payload: Record<string, unknown>): void {
		switch (kind) {
			case 'delta': {
				this.stats.deltas++
				const ev = deltaToEvent(typeof payload.path === 'string' ? payload.path : '', payload.value)
				if (!ev) return
				this.emit('event', ev, 'mixrack')
				const changed = this.state.apply(ev)
				if (changed.length) this.emit('changed', changed)
				return
			}
			case 'scene': {
				const ev: ConsoleEvent = { kind: 'scene', scene: Number(payload.number) }
				this.emit('event', ev, 'mixrack')
				const changed = this.state.apply(ev)
				if (changed.length) this.emit('changed', changed)
				return
			}
			case 'connection': {
				this.consoleState = typeof payload.console === 'string' ? payload.console : 'down'
				this.applyConsoleState()
				return
			}
			case 'ack': {
				if (payload.ok === false) {
					const err = (payload.error ?? {}) as { code?: string }
					this.emit('log', 'debug', `ack ${String(payload.cid)}: ${err.code ?? 'error'}`)
				}
				return
			}
			default:
				return // midi feed etc. — the monitor's business, not ours
		}
	}

	private setStatus(status: LinkStatus, message: string | undefined): void {
		if (this._status === status && this._statusMessage === message) return
		this._status = status
		this._statusMessage = message
		this.emit('status', status, message)
	}
}

// ---------------------------------------------------------------- mapping

/** Bridge mirror path + value → the fixture-contract event our state applies. */
export function deltaToEvent(path: string, value: unknown): ConsoleEvent | undefined {
	const parts = path.split('.')
	if (path === 'scene.current') {
		const n = Number(value)
		return Number.isInteger(n) && n >= 1 ? { kind: 'scene', scene: n } : undefined
	}
	if (path === 'connection.console') return undefined // handled as status
	if (parts.length !== 3) return undefined
	const [type, idxStr, field] = parts
	const index = Number(idxStr)
	if (!isChannelType(type) || !Number.isInteger(index) || index < 1 || index > CHANNEL_TABLE[type].count)
		return undefined
	const ref: ChannelRef = { type, index }
	switch (field) {
		case 'mute':
			return { kind: 'mute', ...ref, on: value === true }
		case 'fader': {
			const lv = typeof value === 'object' && value !== null ? Number((value as { lv?: unknown }).lv) : Number(value)
			if (!Number.isInteger(lv) || lv < 0 || lv > 127) return undefined
			return { kind: 'fader', ...ref, level: lv }
		}
		case 'name':
			return { kind: 'name', ...ref, name: typeof value === 'string' ? value : '' }
		case 'colour':
			return typeof value === 'string' ? { kind: 'colour', ...ref, colour: value as Colour } : undefined
		default:
			return undefined
	}
}
