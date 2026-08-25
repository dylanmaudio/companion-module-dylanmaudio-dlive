import { Regex, type SomeCompanionConfigField } from '@companion-module/base'
import type { PreampGainRange } from './protocol/levels.js'
import type { SyncScope } from './link.js'

export type ModuleConfig = {
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
	transport: 'direct',
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
	if (c.transport !== 'bridge') c.transport = 'direct'
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
			label: 'Allen & Heath dLive',
			value:
				'Talks MIDI over TCP to the <b>MixRack</b> (port 51325). On the console set Utility → Control → MIDI to <b>On</b> (not Secure), enable Global MIDI Send and Receive, and note the base MIDI channel shown there — it must match below. Status goes green only once the desk actually answers.',
		},
		{
			type: 'dropdown',
			id: 'transport',
			label: 'Connect via',
			tooltip:
				'Direct: this module opens its own console sockets. MIDI Bridge: the module attaches to the dLive MIDI Bridge app (Client API), sharing its console connection, state mirror and MIDI Monitor.',
			width: 12,
			default: 'direct',
			choices: [
				{ id: 'direct', label: 'Direct console (TCP)' },
				{ id: 'bridge', label: 'MIDI Bridge app (Client API v1, bridge 1.1+)' },
			],
		},
		{ type: 'textinput', id: 'host', label: 'MixRack IP (direct)', width: 8, regex: Regex.IP, default: '' },
		{ type: 'number', id: 'port', label: 'Port (direct)', width: 4, min: 1, max: 65535, default: 51325 },
		{
			type: 'textinput',
			id: 'bridgeHost',
			label: 'MIDI Bridge address (bridge mode)',
			tooltip:
				'127.0.0.1 when Companion runs on the same Mac as the bridge. The console IP and base channel then come from the bridge.',
			width: 8,
			default: '127.0.0.1',
		},
		{ type: 'number', id: 'bridgePort', label: 'Bridge port', width: 4, min: 1, max: 65535, default: 8765 },
		{
			type: 'textinput',
			id: 'bridgeToken',
			label: 'Bridge token (only for LAN access)',
			tooltip:
				'Leave empty on the same machine. When the bridge exposes its API on the LAN it shows a token — paste it here.',
			width: 12,
			default: '',
		},
		{
			type: 'textinput',
			id: 'surfaceHost',
			label: 'Surface IP (optional)',
			tooltip:
				'Cue-list recall and Scene Go / Next / Previous belong to the Surface (port 51328). Leave blank to send them down the MixRack socket instead.',
			width: 8,
			default: '',
		},
		{ type: 'number', id: 'surfacePort', label: 'Surface port', width: 4, min: 1, max: 65535, default: 51328 },
		{
			type: 'number',
			id: 'baseChannel',
			label: 'Base MIDI channel (1–12)',
			tooltip:
				'Utility → Control → MIDI on the console. Every channel type is an offset from this; a wrong value moves the wrong strip.',
			width: 4,
			min: 1,
			max: 12,
			default: 12,
		},
		{
			type: 'textinput',
			id: 'firmware',
			label: 'Console firmware',
			tooltip: 'Not detectable over MIDI. Recorded in the $(dlive:firmware) variable and used in the support log.',
			width: 4,
			default: '',
		},
		{
			type: 'dropdown',
			id: 'syncScope',
			label: 'Sync on connect',
			width: 4,
			default: 'names_state',
			choices: [
				{ id: 'names', label: 'Names & colours' },
				{ id: 'names_state', label: 'Names, colours, mutes & faders' },
				{ id: 'all', label: 'Everything (slow on a full desk)' },
				{ id: 'none', label: 'Nothing — learn as it happens' },
			],
		},
		{
			type: 'number',
			id: 'inputs',
			label: 'Inputs in use',
			tooltip: 'Bounds the variable grid, presets and the connect-time sync. 128 is the full desk.',
			width: 4,
			min: 1,
			max: 128,
			default: 128,
		},
		{
			type: 'checkbox',
			id: 'extendedTypes',
			label: 'Groups, auxes, matrices, FX & UFX too',
			tooltip: 'Declare variables and presets for every channel type, not only inputs, mains, DCAs and mute groups.',
			width: 8,
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
				'One per line: <control number>,<value>,<name>. Example: 20,1,Band 2 changeover. The console cannot tell us its Actions, so this list is what makes the "Recall Action" dropdown read like your show.',
			width: 12,
			multiline: true,
			default: '',
		},
		{
			type: 'textinput',
			id: 'showFile',
			label: 'Show file (path on the Companion computer)',
			tooltip:
				'A dLive show file (.tar.gz / .dlive) or an unpacked Show folder. Scene names and channel names are read from it — the only way to get scene names, since the MIDI protocol cannot ask for them. Re-read with the "Reload show file" action.',
			width: 12,
			default: '',
		},
		{
			type: 'textinput',
			id: 'sceneNames',
			label: 'Scene names (manual)',
			tooltip: 'One per line: <scene number>,<name>. Overrides names from the show file.',
			width: 12,
			multiline: true,
			default: '',
		},
		{
			type: 'checkbox',
			id: 'sendsInDb',
			label: 'Show send levels in dB',
			tooltip:
				'Send levels are a separate protocol surface whose dB mapping is not yet calibrated. Off: sends show raw 0–127. On: assume the fader table (may be off by a few dB).',
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
		{
			type: 'static-text',
			id: 'infoAdv',
			width: 12,
			label: 'Advanced',
			value:
				'Flow control is undocumented on the dLive. Defaults are conservative; lower them if the desk drops replies under load.',
		},
		{ type: 'number', id: 'inFlight', label: 'Gets in flight', width: 4, min: 1, max: 32, default: 8 },
		{
			type: 'number',
			id: 'pingCoalesceMs',
			label: 'Fader ping coalesce (ms)',
			width: 4,
			min: 0,
			max: 500,
			default: 40,
		},
		{
			type: 'number',
			id: 'pollIntervalMs',
			label: 'Background poll interval (ms)',
			width: 4,
			min: 10,
			max: 2000,
			default: 50,
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
