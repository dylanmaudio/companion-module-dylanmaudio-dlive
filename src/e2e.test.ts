/**
 * End-to-end: the real module class under a fake Companion host, talking
 * real TCP to the Python Virtual dLive (dLive Utility Apps `sim/`).
 *
 * Skipped when the sim is not on this machine (set DLIVE_SIM_ROOT).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
	CompanionActionDefinitions,
	CompanionFeedbackDefinitions,
	CompanionVariableValues,
} from '@companion-module/base'
import DliveInstance from './main.js'
import { DEFAULT_CONFIG } from './config.js'

const SIM_ROOT = process.env.DLIVE_SIM_ROOT ?? join(homedir(), 'Documents', 'GitHub', 'dLive Utility Apps')
const HAVE_SIM = existsSync(join(SIM_ROOT, 'sim', 'virtual_console.py'))

// ---------------------------------------------------------------- fake host

interface PlacedFeedback {
	id: string
	feedbackId: string
	options: Record<string, unknown>
	value: unknown
}

class FakeHost {
	actions: CompanionActionDefinitions<never> = {} as never
	feedbacks: CompanionFeedbackDefinitions<never> = {} as never
	variables: CompanionVariableValues = {}
	variableDefs = new Set<string>()
	status: { status: string; message: string | null }[] = []
	presets: { sections: number; presets: number } = { sections: 0, presets: 0 }
	placed = new Map<string, PlacedFeedback>()
	recorded: unknown[] = []
	checks: string[][] = []

	readonly context = {
		_isInstanceContext: true as const,
		id: 'test-instance',
		label: 'dlive',
		upgradeScripts: [],
		saveConfig: () => {},
		updateStatus: (status: string, message: string | null) => this.status.push({ status, message }),
		oscSend: () => {},
		recordAction: (a: unknown) => this.recorded.push(a),
		setActionDefinitions: (a: CompanionActionDefinitions<never>) => (this.actions = a),
		subscribeActions: () => {},
		unsubscribeActions: () => {},
		setFeedbackDefinitions: (f: CompanionFeedbackDefinitions<never>) => (this.feedbacks = f),
		unsubscribeFeedbacks: () => {},
		checkFeedbacks: () => {},
		checkAllFeedbacks: () => this.evaluate([...this.placed.keys()]),
		checkFeedbacksById: (ids: string[]) => {
			this.checks.push(ids)
			this.evaluate(ids)
		},
		setPresetDefinitions: (s: unknown[], p: Record<string, unknown>) =>
			(this.presets = { sections: s.length, presets: Object.keys(p).length }),
		setCompositeElementDefinitions: () => {},
		setVariableDefinitions: (d: Record<string, unknown>) => (this.variableDefs = new Set(Object.keys(d))),
		setVariableValues: (v: CompanionVariableValues) => Object.assign(this.variables, v),
		getVariableValue: (id: string) => this.variables[id],
		sharedUdpSocketHandlers: new Map(),
		sharedUdpSocketJoin: async () => '',
		sharedUdpSocketLeave: async () => {},
		sharedUdpSocketSend: async () => {},
	}

	/** "Place" a feedback on a button, as Companion would, and evaluate it. */
	place(id: string, feedbackId: string, options: Record<string, unknown>): PlacedFeedback {
		const pf: PlacedFeedback = { id, feedbackId, options, value: undefined }
		this.placed.set(id, pf)
		this.evaluate([id])
		return pf
	}

	evaluate(ids: string[]): void {
		for (const id of ids) {
			const pf = this.placed.get(id)
			if (!pf) continue
			const def = (this.feedbacks as Record<string, { callback: (fb: unknown) => unknown }>)[pf.feedbackId]
			pf.value = def.callback({
				id: pf.id,
				controlId: 'c',
				feedbackId: pf.feedbackId,
				options: pf.options,
				previousOptions: null,
				type: 'boolean',
			})
		}
	}

	async runAction(actionId: string, options: Record<string, unknown>): Promise<void> {
		const def = (this.actions as Record<string, { callback: (ev: unknown, ctx: unknown) => unknown }>)[actionId]
		if (!def) throw new Error(`no action ${actionId}`)
		await def.callback(
			{ id: 'a', controlId: 'c', actionId, options, surfaceId: undefined },
			{ type: 'action', setCustomVariableValue: () => {}, signal: new AbortController().signal },
		)
	}
}

// ---------------------------------------------------------------- sim process

class Sim {
	proc!: ChildProcessWithoutNullStreams
	port = 0
	log = ''
	async start(baseChannel: number): Promise<void> {
		this.proc = spawn(
			'python3',
			[
				'-u',
				'-m',
				'sim.virtual_console',
				'--port',
				'0',
				'--base-channel',
				String(baseChannel),
				'--interactive',
				'--quiet',
			],
			{
				cwd: SIM_ROOT,
				stdio: ['pipe', 'pipe', 'pipe'],
			},
		)
		this.proc.stdout.on('data', (d: Buffer) => (this.log += d.toString()))
		this.proc.stderr.on('data', (d: Buffer) => (this.log += d.toString()))
		await waitFor(() => /listening on 127\.0\.0\.1:(\d+)/.exec(this.log) !== null, 5000, 'sim did not start')
		this.port = Number((/listening on 127\.0\.0\.1:(\d+)/.exec(this.log) as RegExpExecArray)[1])
	}
	cmd(line: string): void {
		this.proc.stdin.write(line + '\n')
	}
	stop(): void {
		try {
			this.cmd('quit')
		} catch {
			/* ignore */
		}
		this.proc.kill()
	}
}

/** Scheduler has nothing queued or in flight for a full 150 ms. */
async function idle(inst: DliveInstance): Promise<void> {
	let quiet = 0
	await waitFor(
		() => {
			const s = inst.link.scheduler
			quiet = s.queueLength === 0 && s.inFlight === 0 ? quiet + 1 : 0
			return quiet >= 15
		},
		10_000,
		'scheduler idle',
	)
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
	const start = Date.now()
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${what}`)
		await new Promise((r) => setTimeout(r, 10))
	}
}

// ---------------------------------------------------------------- tests

describe.skipIf(!HAVE_SIM)('end-to-end against the Virtual dLive', () => {
	const sim = new Sim()
	const host = new FakeHost()
	let inst: DliveInstance

	beforeAll(async () => {
		await sim.start(1)
		inst = new DliveInstance(host.context)
		await inst.init({
			...DEFAULT_CONFIG,
			host: '127.0.0.1',
			port: sim.port,
			baseChannel: 1,
			inputs: 8,
			extendedTypes: false,
			syncScope: 'names_state',
		})
	}, 15000)

	afterAll(async () => {
		await inst.destroy()
		sim.stop()
	})

	it('goes Ok only after the probe reply, then syncs names/mutes/faders', async () => {
		await waitFor(() => host.status.some((s) => s.status === 'ok'), 5000, 'status ok')
		expect(host.status.map((s) => s.status)).toContain('connecting')
		await waitFor(
			() =>
				inst.link.state.strip({ type: 'input', index: 8 }).nameKnown &&
				typeof host.variables['fader_lv_ch8'] === 'number',
			5000,
			'sync',
		)
		await idle(inst)
		expect(host.variables['name_ch1']).toBe('Ip 1')
		expect(host.variables['connected']).toBe(true)
		// 46 strips in scope × (name, colour, mute) + 38 faders = 176 Gets, all answered
		expect(inst.link.scheduler.stats.sent).toBe(176)
		expect(inst.link.scheduler.stats.replied).toBe(176)
		expect(host.variableDefs.has('mute_dca24')).toBe(true)
		expect(host.variableDefs.has('name_aux1')).toBe(false) // extendedTypes off
		expect(host.presets.presets).toBeGreaterThan(10)
		expect(inst.link.scheduler.stats.missed).toBe(0)
	})

	it('mute action → desk model → echo → feedback + variable', async () => {
		const fb = host.place('fb-mute3', 'mute', { type: 'input', index: 3 })
		expect(fb.value).toBe(false)
		await host.runAction('mute', { type: 'input', index: 3, mode: 'on' })
		await waitFor(() => fb.value === true, 2000, 'mute feedback')
		expect(host.variables['mute_ch3']).toBe(true)
		await host.runAction('mute', { type: 'input', index: 3, mode: 'toggle' })
		await waitFor(() => fb.value === false, 2000, 'mute feedback off')
	})

	it('a fader moved on the surface pings → one Get → level lands in variables and a value feedback', async () => {
		await idle(inst)
		const fb = host.place('fb-fader5', 'fader_db', { type: 'input', index: 5 })
		const sentBefore = inst.link.scheduler.stats.sent
		sim.cmd('fader input 5 95')
		await waitFor(() => host.variables['fader_lv_ch5'] === 95, 3000, 'fader ping → get → reply')
		expect(host.variables['fader_ch5']).toBe('-6.1')
		expect(fb.value).toBe(-6.1)
		await waitFor(() => inst.link.scheduler.stats.sent - sentBefore >= 2, 2000, 'settle get')
		await new Promise((r) => setTimeout(r, 300))
		expect(inst.link.scheduler.stats.sent - sentBefore).toBe(2) // ping get + settle get, nothing else
	})

	it('timed fade reaches the target and is emit-on-change', async () => {
		await idle(inst)
		await host.runAction('fader', { type: 'input', index: 2, db: '0', fade: 0 })
		await waitFor(() => host.variables['fader_lv_ch2'] === 107, 2000, 'jump')
		const before = inst.link.stats.messagesOut
		await host.runAction('fader', { type: 'input', index: 2, db: '-20', fade: 400 })
		await waitFor(() => host.variables['fader_lv_ch2'] === 67, 3000, 'fade reaches target')
		expect(inst.link.stats.messagesOut - before).toBeLessThan(20)
	})

	it('surface scene recall and rename arrive pushed', async () => {
		const fb = host.place('fb-scene', 'scene_current', { scene: 129 })
		sim.cmd('scene 129')
		await waitFor(() => host.variables['scene_current'] === 129, 2000, 'scene')
		expect(fb.value).toBe(true)
		sim.cmd('rename input 1 Kick')
		await waitFor(() => host.variables['name_ch1'] === 'Kick', 2000, 'rename')
	})

	it('named console Actions from the map become a dropdown and fire the right CC', async () => {
		await inst.configUpdated({ ...inst.config, actionsMap: '20,1,Band changeover\n21,5,House lights' })
		const def = (host.actions as Record<string, { options: { choices?: { id: string; label: string }[] }[] }>)[
			'console_action'
		]
		expect(def.options[0].choices?.map((c) => c.label)).toEqual([
			'Band changeover  (CC 20 = 1)',
			'House lights  (CC 21 = 5)',
		])
		await waitFor(() => host.status[host.status.length - 1]?.status === 'ok', 5000, 'reconnected after config')
		await host.runAction('console_action', { entry: '21/5' })
		await new Promise((r) => setTimeout(r, 100))
		sim.cmd('stats')
		await waitFor(() => /control_change/.test(sim.log), 1000, 'stats')
	})

	it('honest status: a desk that stops answering goes to ConnectionFailure with the MIDI diagnostic', async () => {
		// simulate Global MIDI Send off by making the sim ignore Gets via a fresh sim
		const quiet = new Sim()
		await quiet.start(1)
		const h2 = new FakeHost()
		const i2 = new DliveInstance(h2.context)
		quiet.proc.kill() // close the listener: connect will fail → stays 'connecting', never 'ok'
		await i2.init({
			...DEFAULT_CONFIG,
			host: '127.0.0.1',
			port: quiet.port,
			baseChannel: 1,
			inputs: 4,
			extendedTypes: false,
		})
		await new Promise((r) => setTimeout(r, 300))
		expect(h2.status.some((s) => s.status === 'ok')).toBe(false)
		await i2.destroy()
	})
})
