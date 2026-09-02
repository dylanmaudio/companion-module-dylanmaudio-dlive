import {
	InstanceBase,
	InstanceStatus,
	type CompanionHTTPRequest,
	type CompanionHTTPResponse,
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
import { parseShowTar, readShowFile } from './showfile/parser.js'
import {
	describeImport,
	extractChunk,
	importedActions,
	importedScenes,
	readImport,
	toImport,
	UploadBuffer,
} from './showfile/upload.js'
import { uploadPageHtml } from './showfile/uploadpage.js'
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
	private readonly uploads = new UploadBuffer()

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
		return GetConfigFields({ label: this.label, showImport: this.config.showImport })
	}

	// ------------------------------------------------------- show file page

	/**
	 * Companion has no file-picker config field, and this process is sandboxed
	 * to its own folder, so a typed path is usually unreadable. Serving a page
	 * of our own gets a real file dialog and the bytes with it.
	 */
	async handleHttpRequest(req: CompanionHTTPRequest): Promise<CompanionHTTPResponse> {
		const path = (req.path ?? '/').replace(/\/+$/, '')
		try {
			if (req.method === 'POST' && path.endsWith('/upload')) return await this.httpUploadShow(req)
			if (req.method === 'POST' && path.endsWith('/remove')) return await this.httpRemoveShow()
			if (req.method !== 'GET') return httpJson(405, { error: `${req.method} not allowed here` })
			return {
				status: 200,
				headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
				body: uploadPageHtml({
					label: this.label,
					imported: describeImport(readImport(this.config.showImport)),
					path: this.config.showFile,
				}),
			}
		} catch (e) {
			const message = (e as Error).message
			this.log('warn', `Show file page: ${message}`)
			return httpJson(400, { error: message })
		}
	}

	private async httpUploadShow(req: CompanionHTTPRequest): Promise<CompanionHTTPResponse> {
		const q = req.query ?? {}
		const name = (q.name || 'show').slice(0, 120)
		const buf = this.uploads.add(q.id ?? '', name, Number(q.part), Number(q.total), extractChunk(req.body))
		if (!buf) return httpJson(200, { done: false })
		const r = parseShowTar(buf, name)
		if (r.sceneNames.size === 0 && r.actions.length === 0)
			return httpJson(400, {
				error: r.warnings[0] ?? 'No scene names or Actions in that file — is it a dLive show?',
			})
		const imported = toImport(r, name, new Date())
		await this.storeShowImport(JSON.stringify(imported))
		this.log('info', `Show file: loaded "${name}" — ${r.sceneNames.size} scene names, ${r.actions.length} Actions`)
		return httpJson(200, {
			done: true,
			name,
			scenes: r.sceneNames.size,
			actions: r.actions.length,
			baseChannel: r.baseChannel ?? null,
			warnings: r.warnings,
			summary: describeImport(imported),
		})
	}

	private async httpRemoveShow(): Promise<CompanionHTTPResponse> {
		await this.storeShowImport('')
		this.log('info', 'Show file: imported show removed')
		return httpJson(200, { ok: true })
	}

	/** Persist the import in the connection config, then re-derive everything from it. */
	private async storeShowImport(showImport: string): Promise<void> {
		this.config = { ...this.config, showImport }
		this.saveConfig(this.config)
		await this.reloadShowFile()
		this.publishDefinitions()
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
		if (this.config.transport === 'bridge' && !this.config.bridgeHost) {
			this.updateStatus(
				InstanceStatus.BadConfig,
				'Enter the MIDI Bridge address (127.0.0.1 if it runs on this machine)',
			)
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
		// In bridge mode the bridge owns the base channel and reports it in /info.
		const baseChannel =
			this.link instanceof BridgeLink
				? (this.link.bridgeBaseChannel ?? this.config.baseChannel)
				: this.config.baseChannel
		return {
			firmware: this.config.firmware,
			baseChannel,
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

	/**
	 * Rebuild scene names and the Actions table from every source, weakest
	 * first: the show file path, then an uploaded show, then whatever the
	 * operator typed into the connection form. Typing always wins — it is the
	 * only way to correct a show that is wrong or out of date.
	 */
	async reloadShowFile(): Promise<void> {
		const names = new Map<number, string>()
		const fromShow = new Map<string, ActionMapEntry>()
		let showBaseChannel: number | undefined

		if (this.config.showFile) {
			try {
				const r = readShowFile(this.config.showFile)
				for (const w of r.warnings) this.log('info', `Show file: ${w}`)
				for (const [n, name] of r.sceneNames) names.set(n, name)
				for (const a of r.actions) fromShow.set(`${a.cc}/${a.value}`, toActionEntry(a.cc, a.value, a.name))
				showBaseChannel = r.baseChannel
				this.log(
					'info',
					`Show file: ${r.sceneNames.size} scene names and ${r.actions.length} Action triggers loaded from ${r.source}`,
				)
			} catch (e) {
				this.log('error', `Show file: ${(e as Error).message}`)
			}
		}

		const imported = readImport(this.config.showImport)
		if (imported) {
			const scenes = importedScenes(imported)
			const actions = importedActions(imported)
			for (const [n, name] of scenes) names.set(n, name)
			for (const a of actions) fromShow.set(`${a.cc}/${a.value}`, toActionEntry(a.cc, a.value, a.name))
			if (imported.baseChannel !== undefined) showBaseChannel = imported.baseChannel
			this.log(
				'info',
				`Show file: ${scenes.size} scene names and ${actions.length} Action triggers from the uploaded show "${imported.name}"`,
			)
		}

		if (showBaseChannel !== undefined && showBaseChannel !== this.config.baseChannel) {
			this.log(
				'warn',
				`Show file says the console's base MIDI channel is ${showBaseChannel}, but the connection is set to ${this.config.baseChannel}`,
			)
		}

		const manualNames = parseSceneNames(this.config.sceneNames)
		for (const e of manualNames.errors) this.log('warn', `Scene names: ${e}`)
		for (const [n, name] of manualNames.names) names.set(n, name)
		this.link.state.sceneNames = names

		const manual = parseActionsMap(this.config.actionsMap)
		const seen = new Set(manual.entries.map((e) => `${e.cc}/${e.value}`))
		const merged = [...manual.entries, ...[...fromShow.values()].filter((a) => !seen.has(`${a.cc}/${a.value}`))]
		const changed = JSON.stringify(merged) !== JSON.stringify(this.actionsMap)
		this.actionsMap = merged
		if (changed) this.setActionDefinitions(buildActions(this))
		this.queueVariables({ scene_current_name: this.link.state.sceneName(this.link.state.currentScene) })
	}
}

function toActionEntry(cc: number, value: number, name: string | undefined): ActionMapEntry {
	return { cc, value, name: name ?? `Action (CC ${cc} = ${value})` }
}

function httpJson(status: number, body: unknown): CompanionHTTPResponse {
	return { status, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) }
}
