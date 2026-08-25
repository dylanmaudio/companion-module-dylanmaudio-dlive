import {
	InstanceBase,
	InstanceStatus,
	type CompanionRecordedAction,
	type CompanionVariableValues,
	type LogLevel,
	type SomeCompanionConfigField,
} from '@companion-module/base'
import {
	GetConfigFields,
	normaliseConfig,
	parseActionsMap,
	parseSceneNames,
	type ActionMapEntry,
	type ModuleConfig,
} from './config.js'
import type { ModuleContext } from './context.js'
import { ConsoleLink, type LinkStatus } from './link.js'
import { BridgeLink } from './bridge/bridgelink.js'
import type { LinkApi } from './link-api.js'
import { TcpTransport } from './transport/transport.js'
import { buildActions, type ActionsSchema } from './actions.js'
import { buildFeedbacks, type FeedbacksSchema } from './feedbacks.js'
import { buildPresets } from './presets.js'
import { UpgradeScripts } from './upgrades.js'
import {
	allVariableValues,
	stripCountsFor,
	valuesForPaths,
	variableDefinitions,
	type MetaValues,
	type VariableScope,
	type VariablesSchema,
} from './variables.js'
import { readShowFile } from './showfile/parser.js'
import { lvToDb } from './protocol/levels.js'
import type { ConsoleEvent } from './protocol/intents.js'

export type ModuleSchema = {
	config: ModuleConfig
	secrets: undefined
	actions: ActionsSchema
	feedbacks: FeedbacksSchema
	variables: VariablesSchema
}

export { UpgradeScripts }

const STATUS_MAP: Record<LinkStatus, InstanceStatus> = {
	disconnected: InstanceStatus.Disconnected,
	connecting: InstanceStatus.Connecting,
	probing: InstanceStatus.Connecting,
	ok: InstanceStatus.Ok,
	failure: InstanceStatus.ConnectionFailure,
}

export default class DliveInstance extends InstanceBase<ModuleSchema> implements ModuleContext {
	config: ModuleConfig = normaliseConfig(null)
	link!: LinkApi
	actionsMap: ActionMapEntry[] = []
	private scope: VariableScope = { inputs: 128, extendedTypes: true }
	private recording = false
	private pendingVariables: CompanionVariableValues = {}
	private variableFlush: NodeJS.Timeout | null = null
	private pendingFeedbackIds = new Set<string>()
	private feedbackFlush: NodeJS.Timeout | null = null

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig): Promise<void> {
		this.config = normaliseConfig(config)
		this.link = this.makeLink()
		this.wireLink()
		this.applyConfig(true)
	}

	async destroy(): Promise<void> {
		this.link?.stop()
		if (this.variableFlush) clearTimeout(this.variableFlush)
		if (this.feedbackFlush) clearTimeout(this.feedbackFlush)
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		const prev = this.config
		this.config = normaliseConfig(config)
		const modeChanged = prev.transport !== this.config.transport
		const directChanged =
			prev.host !== this.config.host ||
			prev.port !== this.config.port ||
			prev.surfaceHost !== this.config.surfaceHost ||
			prev.surfacePort !== this.config.surfacePort ||
			prev.baseChannel !== this.config.baseChannel
		const bridgeChanged =
			prev.bridgeHost !== this.config.bridgeHost ||
			prev.bridgePort !== this.config.bridgePort ||
			prev.bridgeToken !== this.config.bridgeToken
		if (modeChanged || (this.config.transport === 'direct' ? directChanged : bridgeChanged)) {
			this.link.stop()
			this.link.removeAllListeners()
			this.link = this.makeLink()
			this.wireLink()
		} else if (this.link instanceof ConsoleLink) {
			Object.assign(this.link.scheduler.opts, {
				inFlight: this.config.inFlight,
				pingCoalesceMs: this.config.pingCoalesceMs,
				pollIntervalMs: this.config.pollIntervalMs,
			})
			this.link.opts.syncScope = this.config.syncScope
			this.link.opts.stripCounts = stripCountsFor({
				inputs: this.config.inputs,
				extendedTypes: this.config.extendedTypes,
			})
		}
		this.applyConfig(false)
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	// ------------------------------------------------------------ wiring

	private makeLink(): LinkApi {
		if (this.config.transport === 'bridge') {
			return new BridgeLink({
				host: this.config.bridgeHost,
				port: this.config.bridgePort,
				token: this.config.bridgeToken || undefined,
				laneName: this.label,
				baseChannel: this.config.baseChannel,
			})
		}
		return new ConsoleLink(this.makeTransport(), this.linkOptions())
	}

	private makeTransport(): TcpTransport {
		return new TcpTransport({
			host: this.config.host,
			port: this.config.port,
			surfaceHost: this.config.surfaceHost || undefined,
			surfacePort: this.config.surfacePort,
		})
	}

	private linkOptions() {
		return {
			baseChannel: this.config.baseChannel,
			syncScope: this.config.syncScope,
			stripCounts: stripCountsFor({ inputs: this.config.inputs, extendedTypes: this.config.extendedTypes }),
			scheduler: {
				inFlight: this.config.inFlight,
				pingCoalesceMs: this.config.pingCoalesceMs,
				pollIntervalMs: this.config.pollIntervalMs,
			},
		}
	}

	private wireLink(): void {
		this.link.on('status', (status, message) => {
			this.updateStatus(STATUS_MAP[status], message ?? null)
			this.queueVariables({ connected: this.link.state.connected })
		})
		this.link.on('log', (level, message) => this.log(level, message))
		this.link.on('changed', (paths) => this.onChanged(paths))
		this.link.on('event', (ev) => this.onEvent(ev))
	}

	private applyConfig(first: boolean): void {
		const map = parseActionsMap(this.config.actionsMap)
		for (const e of map.errors) this.log('warn', `Actions map: ${e}`)
		this.actionsMap = map.entries
		this.scope = { inputs: this.config.inputs, extendedTypes: this.config.extendedTypes }

		this.setActionDefinitions(buildActions(this))
		this.setFeedbackDefinitions(buildFeedbacks(this))
		void this.reloadShowFile().then(() => this.publishDefinitions())
		if (this.config.transport === 'direct' && !this.config.host) {
			this.updateStatus(InstanceStatus.BadConfig, 'Enter the MixRack IP address (or switch to bridge mode)')
			return
		}
		if (first || this.link.status === 'disconnected') this.link.start()
	}

	private publishDefinitions(): void {
		this.setVariableDefinitions(variableDefinitions(this.scope, this.link.state.sceneNames.keys()))
		this.setVariableValues(allVariableValues(this.link.state, this.scope, this.meta()))
		const { sections, presets } = buildPresets(this, this.scope)
		this.setPresetDefinitions(sections, presets)
		this.link.subscriptions.clear()
		this.checkAllFeedbacks()
	}

	private meta(): MetaValues {
		const d = this.link.diag()
		return {
			firmware: this.config.firmware,
			baseChannel: this.config.baseChannel,
			getsInFlight: d.getsInFlight,
			getsMissed: d.getsMissed,
			unsupported: d.unsupported,
		}
	}

	// ------------------------------------------------------------ state → Companion

	private onChanged(paths: string[]): void {
		const ids = this.link.subscriptions.feedbacksFor(paths)
		for (const id of ids) this.pendingFeedbackIds.add(id)
		if (!this.feedbackFlush) {
			this.feedbackFlush = setTimeout(() => {
				this.feedbackFlush = null
				const list = [...this.pendingFeedbackIds]
				this.pendingFeedbackIds.clear()
				if (list.length) this.checkFeedbacksById(...list)
			}, 15)
		}
		this.queueVariables(valuesForPaths(this.link.state, paths, this.scope, this.meta()))
	}

	/** Batch variable writes — a scene recall on a 128-channel desk must not be 500 IPC calls. */
	private queueVariables(values: CompanionVariableValues): void {
		Object.assign(this.pendingVariables, values)
		if (this.variableFlush) return
		this.variableFlush = setTimeout(() => {
			this.variableFlush = null
			const v = this.pendingVariables
			this.pendingVariables = {}
			if (Object.keys(v).length) this.setVariableValues(v)
		}, 20)
	}

	private onEvent(ev: ConsoleEvent): void {
		if (this.config.debugEvents) this.log('debug', `← ${JSON.stringify(ev)}`)
		if (!this.recording) return
		// Action Recorder: surface moves become actions; a fader sweep collapses to its final value
		let rec: CompanionRecordedAction | undefined
		let uid: string | undefined
		switch (ev.kind) {
			case 'mute':
				rec = { actionId: 'mute', options: { type: ev.type, index: ev.index, mode: ev.on ? 'on' : 'off' } }
				uid = `mute:${ev.type}/${ev.index}`
				break
			case 'fader': {
				const db = lvToDb(ev.level)
				rec = {
					actionId: 'fader',
					options: { type: ev.type, index: ev.index, db: db === null ? '-inf' : db.toFixed(1), fade: 0 },
				}
				uid = `fader:${ev.type}/${ev.index}`
				break
			}
			case 'scene':
				rec = { actionId: 'scene_recall', options: { scene: ev.scene } }
				uid = `scene`
				break
			default:
				return
		}
		this.recordAction(rec, uid)
	}

	handleStartStopRecordActions(isRecording: boolean): void {
		this.recording = isRecording
	}

	// ------------------------------------------------------------ ModuleContext

	log(level: LogLevel, message: string): void {
		super.log(level, message)
	}

	resync(): void {
		this.link.state.reset()
		this.link.sync(this.config.syncScope === 'none' ? 'names_state' : this.config.syncScope)
		this.setVariableValues(allVariableValues(this.link.state, this.scope, this.meta()))
		this.checkAllFeedbacks()
	}

	async reloadShowFile(): Promise<void> {
		const names = new Map<number, string>()
		const showActions: ActionMapEntry[] = []
		if (this.config.showFile) {
			try {
				const r = readShowFile(this.config.showFile)
				for (const w of r.warnings) this.log('info', `Show file: ${w}`)
				for (const [n, name] of r.sceneNames) names.set(n, name)
				for (const a of r.actions)
					showActions.push({ cc: a.cc, value: a.value, name: a.name ?? `Action (CC ${a.cc} = ${a.value})` })
				if (r.baseChannel !== undefined && r.baseChannel !== this.config.baseChannel) {
					this.log(
						'warn',
						`Show file says the console's base MIDI channel is ${r.baseChannel}, but the connection is set to ${this.config.baseChannel}`,
					)
				}
				this.log(
					'info',
					`Show file: ${r.sceneNames.size} scene names and ${r.actions.length} Action triggers loaded from ${r.source}`,
				)
			} catch (e) {
				this.log('error', `Show file: ${(e as Error).message}`)
			}
		}
		const manual = parseSceneNames(this.config.sceneNames)
		for (const e of manual.errors) this.log('warn', `Scene names: ${e}`)
		for (const [n, name] of manual.names) names.set(n, name)
		this.link.state.sceneNames = names
		// Actions: manual map entries win over show-file triggers on the same cc/value
		const map = parseActionsMap(this.config.actionsMap)
		const seen = new Set(map.entries.map((e) => `${e.cc}/${e.value}`))
		const merged = [...map.entries, ...showActions.filter((a) => !seen.has(`${a.cc}/${a.value}`))]
		const changed = JSON.stringify(merged) !== JSON.stringify(this.actionsMap)
		this.actionsMap = merged
		if (changed) this.setActionDefinitions(buildActions(this))
		this.queueVariables({ scene_current_name: this.link.state.sceneName(this.link.state.currentScene) })
	}
}
