/**
 * BridgeLink against a mock Client API v1 server. The mock's shapes are
 * checked against fixtures/api/exchanges.json (authored bridge-side,
 * vendored here) so the two implementations can't drift silently.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BridgeLink, deltaToEvent } from './bridgelink.js'
import { encode, toHex } from '../protocol/encode.js'

const here = dirname(fileURLToPath(import.meta.url))
const exchanges = JSON.parse(readFileSync(join(here, '..', '..', 'fixtures', 'api', 'exchanges.json'), 'utf8')) as {
	cases: {
		id: string
		request: { method: string; path: string; body?: Record<string, unknown> }
		response: { status: number; body: Record<string, unknown> }
		sends?: string[]
	}[]
}
const fixture = (id: string) => {
	const c = exchanges.cases.find((x) => x.id === id)
	if (!c) throw new Error(`no api fixture ${id}`)
	return c
}

interface Cmd {
	body: Record<string, unknown>
}

class MockBridge {
	server!: Server
	port = 0
	baseChannel = 1
	consoleState = 'connected'
	snapshot: Record<string, unknown> = {}
	seq = 100
	cmds: Cmd[] = []
	hellos: Record<string, unknown>[] = []
	laneCounter = 0
	activeLanes = new Set<string>()
	resyncNextStream = false
	rejectCmdOnceWith: number | null = null
	private sse: ServerResponse | null = null

	async start(): Promise<void> {
		this.server = createServer((req, res) => void this.route(req, res))
		await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r))
		const addr = this.server.address()
		if (typeof addr === 'object' && addr) this.port = addr.port
	}

	stop(): void {
		this.sse?.end()
		this.server.close()
	}

	pushEvent(kind: string, payload: Record<string, unknown>): void {
		this.seq++
		const enriched = { v: 1, session: 'main', seq: this.seq, ts: Date.now(), ...payload }
		this.sse?.write(`id: ${this.seq}\nevent: ${kind}\ndata: ${JSON.stringify(enriched)}\n\n`)
	}

	get streamOpen(): boolean {
		return this.sse !== null
	}

	sseClose(): void {
		this.sse?.end()
		this.sse = null
	}

	private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? '/', 'http://x')
		const body = await readBody(req)
		const send = (status: number, obj: unknown) => {
			res.writeHead(status, { 'Content-Type': 'application/json' })
			res.end(JSON.stringify(obj))
		}
		if (url.pathname === '/api/v1/info') {
			send(200, {
				v: 1,
				session: 'main',
				api: 1,
				base_channel: this.baseChannel,
				capabilities: { raw: true, fade: true, query: true, fader_db: true, send_level: false },
				seq: this.seq,
			})
			return
		}
		if (url.pathname === '/api/v1/hello') {
			this.hellos.push(body)
			const laneId = `ln_${String(++this.laneCounter).padStart(4, '0')}`
			this.activeLanes.add(laneId)
			send(200, { v: 1, session: 'main', lane_id: laneId, capabilities: { raw: true }, seq: this.seq })
			return
		}
		if (url.pathname === '/api/v1/state') {
			send(200, {
				v: 1,
				session: 'main',
				seq: this.seq,
				state: { 'connection.console': this.consoleState, ...this.snapshot },
			})
			return
		}
		if (url.pathname === '/api/v1/stream') {
			if (this.resyncNextStream) {
				this.resyncNextStream = false
				send(409, fixture('stream.resync').response.body)
				return
			}
			res.writeHead(200, { 'Content-Type': 'text/event-stream' })
			this.sse = res
			res.on('close', () => {
				if (this.sse === res) this.sse = null
			})
			return
		}
		if (url.pathname === '/api/v1/cmd') {
			if (this.rejectCmdOnceWith !== null) {
				const status = this.rejectCmdOnceWith
				this.rejectCmdOnceWith = null
				send(status, { ok: false, error: { code: status === 401 ? 'unknown_lane' : 'capability_off' } })
				return
			}
			if (!this.activeLanes.has(String(body.lane_id))) {
				send(401, fixture('cmd.unknown_lane').response.body)
				return
			}
			this.cmds.push({ body })
			const intent = body.intent as Record<string, unknown>
			if (intent.op === 'send_level') {
				send(409, fixture('cmd.send_level.capability_off').response.body)
				return
			}
			send(200, { cid: body.cid, ok: true })
			return
		}
		if (req.method === 'DELETE' && url.pathname.startsWith('/api/v1/lane/')) {
			send(200, { ok: true })
			return
		}
		send(404, { ok: false })
	}
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve) => {
		let data = ''
		req.on('data', (c: Buffer) => (data += c.toString()))
		req.on('end', () => {
			try {
				resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {})
			} catch {
				resolve({})
			}
		})
	})
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
	const start = Date.now()
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${what}`)
		await new Promise((r) => setTimeout(r, 10))
	}
}

describe('BridgeLink', () => {
	let bridge: MockBridge
	let link: BridgeLink
	let changes: string[][]
	let logs: string[]

	beforeEach(async () => {
		bridge = new MockBridge()
		await bridge.start()
		link = new BridgeLink({
			host: '127.0.0.1',
			port: bridge.port,
			laneName: 'dLive-test',
			baseChannel: 12,
			retryMs: 50,
		})
		changes = []
		logs = []
		link.on('changed', (p) => changes.push(p))
		link.on('log', (_l, m) => logs.push(m))
	})
	afterEach(() => {
		link.stop()
		bridge.stop()
	})

	it('hello matches the fixture shape, snapshot applies, status is probing-honest', async () => {
		bridge.snapshot = {
			'input.1.name': 'Kick',
			'input.1.mute': true,
			'input.5.fader': { lv: 95, db: -6.1 },
			'scene.current': 12,
		}
		link.start()
		await waitFor(() => link.isOk, 'ok')
		// hello body carries exactly the fixture request fields
		const fx = fixture('hello.ok').request.body as Record<string, unknown>
		expect(bridge.hellos[0]).toMatchObject({ v: fx.v, session: fx.session, kind: fx.kind })
		expect(bridge.hellos[0].name).toBe('dLive-test')
		// mirror landed in ConsoleState
		expect(link.state.strip({ type: 'input', index: 1 }).name).toBe('Kick')
		expect(link.state.strip({ type: 'input', index: 1 }).mute).toBe(true)
		expect(link.state.strip({ type: 'input', index: 5 }).level).toBe(95)
		expect(link.state.currentScene).toBe(12)
		expect(link.bridgeBaseChannel).toBe(1)
	})

	it('reports failure (not ok) when the bridge is up but the console is down', async () => {
		bridge.consoleState = 'down'
		link.start()
		await waitFor(() => link.status === 'failure', 'failure')
		expect(link.statusMessage).toMatch(/console link is down/)
		bridge.pushEvent('connection', { console: 'connected' })
		await waitFor(() => link.isOk, 'recovers')
	})

	it('deltas over SSE update state and emit changed', async () => {
		link.start()
		await waitFor(() => link.isOk && bridge.streamOpen, 'stream')
		bridge.pushEvent('delta', { path: 'input.3.mute', value: true, provenance: { source: 'surface' } })
		bridge.pushEvent('delta', { path: 'input.5.fader', value: { lv: 107, db: 0.0 }, provenance: { source: 'surface' } })
		bridge.pushEvent('scene', { number: 129, name: null })
		await waitFor(() => link.state.currentScene === 129, 'scene')
		expect(link.state.strip({ type: 'input', index: 3 }).mute).toBe(true)
		expect(link.state.strip({ type: 'input', index: 5 }).level).toBe(107)
		expect(changes.flat()).toContain('mute/input/3')
		expect(changes.flat()).toContain('fader/input/5')
	})

	it('first-class sets post the fixture intent verbatim; others ride op raw with module-encoded hex', async () => {
		link.start()
		await waitFor(() => link.isOk, 'ok')
		link.send({ op: 'mute', type: 'input', index: 1, on: true })
		await waitFor(() => bridge.cmds.length >= 1, 'cmd1')
		const fx = fixture('cmd.mute.input1.on').request.body.intent
		expect(bridge.cmds[0].body.intent).toEqual(fx)
		expect(bridge.cmds[0].body).toMatchObject({ v: 1, session: 'main' })
		// optimistic mirror
		expect(link.state.strip({ type: 'input', index: 1 }).mute).toBe(true)

		link.send({ op: 'main_assign', type: 'input', index: 2, on: true })
		await waitFor(() => bridge.cmds.length >= 2, 'cmd2')
		// hex must be the module encoder's bytes at the BRIDGE's base channel (1)
		expect(bridge.cmds[1].body.intent).toEqual({
			op: 'raw',
			hex: toHex(encode(0, { op: 'main_assign', type: 'input', index: 2, on: true })),
		})
	})

	it('fades go to the bridge fade op with to_lv', async () => {
		link.start()
		await waitFor(() => link.isOk, 'ok')
		link.fadeTo({ type: 'input', index: 5 }, 95, 2000)
		await waitFor(() => bridge.cmds.length >= 1, 'fade')
		expect(bridge.cmds[0].body.intent).toEqual({ op: 'fade', type: 'input', index: 5, to_lv: 95, over_ms: 2000 })
		// zero duration bypasses the fade op
		link.fadeTo({ type: 'input', index: 5 }, 0, 0)
		await waitFor(() => bridge.cmds.length >= 2, 'jump')
		expect((bridge.cmds[1].body.intent as { op: string }).op).toBe('fader')
	})

	it('capability_off is reported politely, never a crash', async () => {
		link.start()
		await waitFor(() => link.isOk, 'ok')
		link.send({ op: 'send_level', type: 'input', index: 1, dest_type: 'mono_aux', dest_index: 1, level: 100 })
		await waitFor(() => logs.some((l) => l.includes('capability_off')), 'logged')
		expect(link.isOk).toBe(true)
		expect(link.diag().getsMissed).toBe(1)
	})

	it('409 on the stream resyncs from a fresh snapshot', async () => {
		link.start()
		await waitFor(() => link.isOk && bridge.streamOpen, 'stream up')
		bridge.snapshot = { 'input.9.name': 'Snare' }
		bridge.resyncNextStream = true
		bridge.sseClose()
		await waitFor(() => link.state.strip({ type: 'input', index: 9 }).name === 'Snare', 'resynced')
		await waitFor(() => bridge.streamOpen, 'stream re-established')
		expect(link.isOk).toBe(true)
	})

	it('a reaped lane re-registers on 401 and the command still lands', async () => {
		link.start()
		await waitFor(() => link.isOk, 'ok')
		bridge.rejectCmdOnceWith = 401
		link.send({ op: 'mute', type: 'input', index: 4, on: true })
		await waitFor(() => bridge.cmds.length >= 1, 'retried cmd')
		expect(bridge.hellos.length).toBe(2)
		expect((bridge.cmds[0].body.intent as { index: number }).index).toBe(4)
	})

	it('deltaToEvent rejects junk honestly', () => {
		expect(deltaToEvent('input.5.fader', { lv: 95, db: -6.1 })).toEqual({
			kind: 'fader',
			type: 'input',
			index: 5,
			level: 95,
		})
		expect(deltaToEvent('input.999.mute', true)).toBeUndefined()
		expect(deltaToEvent('bogus.5.mute', true)).toBeUndefined()
		expect(deltaToEvent('input.5.fader', { lv: 300 })).toBeUndefined()
		expect(deltaToEvent('connection.console', 'connected')).toBeUndefined()
		expect(deltaToEvent('scene.current', 12)).toEqual({ kind: 'scene', scene: 12 })
	})
})
