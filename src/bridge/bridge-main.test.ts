/**
 * Bridge mode through the real DliveInstance: config transport='bridge',
 * a mock Client API server, and the action → cmd → optimistic state →
 * variables pipeline that the Companion UI exercises.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { CompanionActionDefinitions, CompanionVariableValues } from '@companion-module/base'
import DliveInstance from '../main.js'
import { DEFAULT_CONFIG } from '../config.js'

class Host {
	actions: CompanionActionDefinitions<never> = {} as never
	vars: CompanionVariableValues = {}
	statuses: string[] = []
	readonly context = {
		_isInstanceContext: true as const,
		id: 't',
		label: 'dLive-test',
		upgradeScripts: [],
		saveConfig: () => {},
		updateStatus: (s: string) => this.statuses.push(s),
		oscSend: () => {},
		recordAction: () => {},
		setActionDefinitions: (a: CompanionActionDefinitions<never>) => (this.actions = a),
		subscribeActions: () => {},
		unsubscribeActions: () => {},
		setFeedbackDefinitions: () => {},
		unsubscribeFeedbacks: () => {},
		checkFeedbacks: () => {},
		checkAllFeedbacks: () => {},
		checkFeedbacksById: () => {},
		setPresetDefinitions: () => {},
		setCompositeElementDefinitions: () => {},
		setVariableDefinitions: () => {},
		setVariableValues: (v: CompanionVariableValues) => Object.assign(this.vars, v),
		getVariableValue: (id: string) => this.vars[id],
		sharedUdpSocketHandlers: new Map(),
		sharedUdpSocketJoin: async () => '',
		sharedUdpSocketLeave: async () => {},
		sharedUdpSocketSend: async () => {},
	}
	async run(actionId: string, options: Record<string, unknown>): Promise<void> {
		const def = (this.actions as Record<string, { callback: (e: unknown, c: unknown) => unknown }>)[actionId]
		await def.callback(
			{ id: 'a', controlId: 'c', actionId, options, surfaceId: undefined },
			{ type: 'action', setCustomVariableValue: () => {}, signal: new AbortController().signal },
		)
	}
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
	const start = Date.now()
	while (!cond()) {
		if (Date.now() - start > 4000) throw new Error(`timeout: ${what}`)
		await new Promise((r) => setTimeout(r, 10))
	}
}

describe('bridge mode through DliveInstance', () => {
	let server: Server
	let port = 0
	const cmds: Record<string, unknown>[] = []

	beforeEach(async () => {
		cmds.length = 0
		server = createServer((req, res) => {
			let data = ''
			req.on('data', (c: Buffer) => (data += c.toString()))
			req.on('end', () => {
				const p = new URL(req.url ?? '/', 'http://x').pathname
				const send = (st: number, o: unknown) => {
					res.writeHead(st, { 'Content-Type': 'application/json' })
					res.end(JSON.stringify(o))
				}
				if (p === '/api/v1/info')
					return send(200, { v: 1, base_channel: 12, capabilities: { raw: true, fade: true }, seq: 5 })
				if (p === '/api/v1/hello') return send(200, { v: 1, lane_id: 'ln_1', seq: 5 })
				if (p === '/api/v1/state')
					return send(200, {
						v: 1,
						seq: 5,
						state: { 'connection.console': 'connected', 'input.7.fader': { lv: 101, db: -3.1 } },
					})
				if (p === '/api/v1/stream') return res.writeHead(200, { 'Content-Type': 'text/event-stream' })
				if (p === '/api/v1/cmd') {
					cmds.push(JSON.parse(data) as Record<string, unknown>)
					return send(200, { ok: true })
				}
				send(404, {})
			})
		})
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
		const addr = server.address()
		if (typeof addr === 'object' && addr) port = addr.port
	})
	afterEach(() => server.close())

	it('action → cmd → optimistic state → variables, and the snapshot seeds variables', async () => {
		const host = new Host()
		const inst = new DliveInstance(host.context)
		await inst.init({ ...DEFAULT_CONFIG, transport: 'bridge', bridgeHost: '127.0.0.1', bridgePort: port, inputs: 16 })
		await waitFor(() => inst.link.isOk, 'ok')
		await waitFor(() => host.vars['fader_lv_ch7'] === 101, 'snapshot variable')
		await host.run('fader', { type: 'input', index: 1, db: '+1', fade: 0 })
		await waitFor(() => host.vars['fader_lv_ch1'] === 109, 'optimistic variable')
		expect(host.vars['fader_ch1']).toBe('+0.9')
		expect((cmds.at(-1) as { intent: { op: string; level: number } }).intent).toEqual({
			op: 'fader',
			type: 'input',
			index: 1,
			level: 109,
		})
		await inst.destroy()
	})
})
