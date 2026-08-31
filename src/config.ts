import type { SomeCompanionConfigField } from '@companion-module/base'
import type { PreampGainRange } from './protocol/levels.js'
import type { SyncScope } from './link.js'

export type ModuleConfig = {
	/**
	 * NOT surfaced in the connection UI — this module is bridge-only.
	 * Direct mode survives solely as the protocol test harness: it is what
	 * `src/e2e.test.ts` drives against the Virtual dLive, and what the
	 * hardware capture work uses. Users have no way to select it.
	 */
	transport: 'direct' | 'bridge'
	bridgeHost: string
	bridgePort: number
	bridgeToken: string
	host: string
	port: number
	surfaceHost: string
	surfacePort: number
	baseChannel: number
	firmware: string
	syncScope: SyncScope
	inputs: number
	extendedTypes: boolean
	goCc: number
	goValue: number
	nextCc: number
	nextValue: number
	prevCc: number
	prevValue: number
	actionsMap: string
	showFile: string
	sceneNames: string
	sendsInDb: boolean
	preampGainRange: PreampGainRange
	inFlight: number
	pingCoalesceMs: number
	pollIntervalMs: number
	debugEvents: boolean
}

export const DEFAULT_CONFIG: ModuleConfig = {
	transport: 'bridge',
	bridgeHost: '127.0.0.1',
	bridgePort: 8765,
	bridgeToken: '',
	host: '',
	port: 51325,
	surfaceHost: '',
	surfacePort: 51328,
	baseChannel: 12,
	firmware: '',
	syncScope: 'names_state',
	inputs: 128,
	extendedTypes: true,
	goCc: 0,
	goValue: 0,
	nextCc: 0,
	nextValue: 0,
	prevCc: 0,
	prevValue: 0,
	actionsMap: '',
	showFile: '',
	sceneNames: '',
	sendsInDb: false,
	preampGainRange: 'spec',
	inFlight: 8,
	pingCoalesceMs: 40,
	pollIntervalMs: 50,
	debugEvents: false,
}

export function normaliseConfig(raw: Partial<ModuleConfig> | null | undefined): ModuleConfig {
	const c = { ...DEFAULT_CONFIG, ...(raw ?? {}) }
	if (c.transport !== 'direct') c.transport = 'bridge'
	if (!c.bridgeHost) c.bridgeHost = '127.0.0.1'
	c.bridgePort = clampInt(c.bridgePort, 1, 65535, 8765)
	c.port = clampInt(c.port, 1, 65535, 51325)
	c.surfacePort = clampInt(c.surfacePort, 1, 65535, 51328)
	c.baseChannel = clampInt(c.baseChannel, 1, 12, 12)
	c.inputs = clampInt(c.inputs, 1, 128, 128)
	c.inFlight = clampInt(c.inFlight, 1, 32, 8)
	c.pingCoalesceMs = clampInt(c.pingCoalesceMs, 0, 500, 40)
	c.pollIntervalMs = clampInt(c.pollIntervalMs, 10, 2000, 50)
	for (const k of ['goCc', 'goValue', 'nextCc', 'nextValue', 'prevCc', 'prevValue'] as const)
		c[k] = clampInt(c[k], 0, 127, 0)
	if (c.preampGainRange !== 'spec' && c.preampGainRange !== 'legacy') c.preampGainRange = 'spec'
	if (!['names', 'names_state', 'all', 'none'].includes(c.syncScope)) c.syncScope = 'names_state'
	return c
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
	const n = typeof v === 'number' ? v : Number(v)
	if (!Number.isFinite(n)) return dflt
	return Math.max(min, Math.min(max, Math.round(n)))
}

export function GetConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'static-text',
			id: 'info',
			width: 12,
			label: 'dLive MIDI Bridge',
			value:
				'This module talks to the <b>dLive MIDI Bridge</b> application, which owns the connection to the console. Set the console address, base MIDI channel and reconnect behaviour <b>in the bridge</b> — this module inherits them. Status goes green only once the bridge reports its console link is up.',
		},
		{
			type: 'textinput',
			id: 'bridgeHost',
			label: 'MIDI Bridge address',
			tooltip: '127.0.0.1 when Companion runs on the same machine as the bridge.',
			width: 8,
			default: '127.0.0.1',
		},
		{ type: 'number', id: 'bridgePort', label: 'Bridge port', width: 4, min: 1, max: 65535, default: 8765 },
		{
			type: 'textinput',
			id: 'bridgeToken',
			label: 'Bridge token (LAN access only)',
			tooltip:
				'Leave empty on the same machine. When the bridge exposes its API on the LAN it shows a token — paste it here.',
			width: 12,
			default: '',
		},
		{
			type: 'textinput',
			id: 'firmware',
			label: 'Console firmware',
			tooltip: 'Not detectable over MIDI. Recorded in the $(dlive:firmware) variable and used in the support log.',
			width: 6,
			default: '',
		},
		{
			type: 'number',
			id: 'inputs',
			label: 'Inputs in use',
			tooltip: 'Bounds the variable grid and the preset library. 128 is the full desk.',
			width: 6,
			min: 1,
			max: 128,
			default: 128,
		},
		{
			type: 'checkbox',
			id: 'extendedTypes',
			label: 'Groups, auxes, matrices, FX & UFX too',
			tooltip: 'Declare variables and presets for every channel type, not only inputs, mains, DCAs and mute groups.',
			width: 12,
			default: true,
		},
		{
			type: 'static-text',
			id: 'infoScene',
			width: 12,
			label: 'Scene Go / Next / Previous',
			value:
				'These are user-assigned CC messages on the console (Utility → Control → MIDI → Scene control). Enter the control number and value you chose there; 0/0 means "not assigned".',
		},
		{ type: 'number', id: 'goCc', label: 'Go — CC', width: 2, min: 0, max: 127, default: 0 },
		{ type: 'number', id: 'goValue', label: 'Go — value', width: 2, min: 0, max: 127, default: 0 },
		{ type: 'number', id: 'nextCc', label: 'Next — CC', width: 2, min: 0, max: 127, default: 0 },
		{ type: 'number', id: 'nextValue', label: 'Next — value', width: 2, min: 0, max: 127, default: 0 },
		{ type: 'number', id: 'prevCc', label: 'Previous — CC', width: 2, min: 0, max: 127, default: 0 },
		{ type: 'number', id: 'prevValue', label: 'Previous — value', width: 2, min: 0, max: 127, default: 0 },
		{
			type: 'textinput',
			id: 'actionsMap',
			label: 'Console Actions map',
			tooltip:
				'One per line: <control number>,<value>,<name>. Optional when a firmware 2.1x show file is loaded — Actions import from it automatically. Manual lines win on the same CC/value.',
			width: 12,
			multiline: true,
			default: '',
		},
		{
			type: 'textinput',
			id: 'showFile',
			label: 'Show file (path on the Companion computer)',
			tooltip:
				'A dLive show (.tar.gz from the console USB export, or an unpacked Show folder). Loads scene names — the only source, since the protocol cannot ask for them — and the named Actions table from firmware ~2.1x shows.',
			width: 12,
			default: '',
		},
		{
			type: 'textinput',
			id: 'sceneNames',
			label: 'Scene names (manual)',
			tooltip: 'One per line: <scene number>,<name>. Overrides the show file.',
			width: 12,
			multiline: true,
			default: '',
		},
		{
			type: 'checkbox',
			id: 'sendsInDb',
			label: 'Show send levels in dB',
			tooltip:
				'Send levels are a separate protocol surface whose dB mapping is not yet calibrated. Off: raw 0–127. On: assume the fader table (may be off by a few dB).',
			width: 6,
			default: false,
		},
		{
			type: 'dropdown',
			id: 'preampGainRange',
			label: 'Preamp gain range',
			tooltip: 'Sources disagree on the preamp gain scale. Pick the one that matches what your screen shows.',
			width: 6,
			default: 'spec',
			choices: [
				{ id: 'spec', label: '+5 … +60 dB (V2.0 spec)' },
				{ id: 'legacy', label: '−10 … +50 dB (legacy module)' },
			],
		},
		{ type: 'checkbox', id: 'debugEvents', label: 'Log every decoded event (debug)', width: 12, default: false },
	]
}

export interface ActionMapEntry {
	cc: number
	value: number
	name: string
}

/** "20,1,Band 2 changeover" per line → entries. Bad lines are reported, not fatal. */
export function parseActionsMap(text: string): { entries: ActionMapEntry[]; errors: string[] } {
	const entries: ActionMapEntry[] = []
	const errors: string[] = []
	for (const raw of (text ?? '').split(/\r?\n/)) {
		const line = raw.trim()
		if (!line || line.startsWith('#')) continue
		const m = /^(\d{1,3})\s*[,;\t]\s*(\d{1,3})\s*[,;\t]\s*(.+)$/.exec(line)
		if (!m) {
			errors.push(`"${line}" — expected <cc>,<value>,<name>`)
			continue
		}
		const cc = Number(m[1])
		const value = Number(m[2])
		if (cc > 127 || value > 127) {
			errors.push(`"${line}" — CC and value must be 0–127`)
			continue
		}
		entries.push({ cc, value, name: m[3].trim() })
	}
	return { entries, errors }
}

/** "129,Intro" per line → map. */
export function parseSceneNames(text: string): { names: Map<number, string>; errors: string[] } {
	const names = new Map<number, string>()
	const errors: string[] = []
	for (const raw of (text ?? '').split(/\r?\n/)) {
		const line = raw.trim()
		if (!line || line.startsWith('#')) continue
		const m = /^(\d{1,3})\s*[,;\t]\s*(.+)$/.exec(line)
		if (!m) {
			errors.push(`"${line}" — expected <scene>,<name>`)
			continue
		}
		const scene = Number(m[1])
		if (scene < 1 || scene > 500) {
			errors.push(`"${line}" — scene must be 1–500`)
			continue
		}
		names.set(scene, m[2].trim())
	}
	return { names, errors }
}
