/**
 * Presets — template groups (API 2.1): one parameterised button per kind,
 * expanded over every strip in scope. The strip number lives in a local
 * variable (`$(local:ch)`), the desk name and level come through feedback
 * local variables, so a Stream Deck page labels and colours itself from
 * the show.
 */

import { combineRgb, type CompanionPresetDefinitions, type CompanionPresetSection } from '@companion-module/base'
import type { ModuleSchema } from './main.js'
import type { ModuleContext } from './context.js'
import { CHANNEL_TABLE, CHANNEL_TYPES, type ChannelType } from './protocol/channels.js'
import { scopedStrips, type VariableScope } from './variables.js'

const WHITE = combineRgb(255, 255, 255)
const BLACK = combineRgb(0, 0, 0)
const DARK = combineRgb(20, 20, 20)
const RED = combineRgb(200, 0, 0)
const GREEN = combineRgb(0, 160, 60)
const BLUE = combineRgb(30, 60, 200)

const expr = (value: string) => ({ isExpression: true as const, value })

export function buildPresets(
	ctx: ModuleContext,
	scope: VariableScope,
): { sections: CompanionPresetSection<ModuleSchema>[]; presets: CompanionPresetDefinitions<ModuleSchema> } {
	const presets: CompanionPresetDefinitions<ModuleSchema> = {}
	const sections: CompanionPresetSection<ModuleSchema>[] = []

	const counts = new Map<ChannelType, number>()
	for (const ref of scopedStrips(scope)) counts.set(ref.type, Math.max(counts.get(ref.type) ?? 0, ref.index))
	const typesInScope = CHANNEL_TYPES.filter((t) => counts.has(t))

	// ---------------------------------------------------------------- per-type templates
	const nameVar = (type: ChannelType) => ({
		variableType: 'feedback' as const,
		variableName: 'name',
		feedbackId: 'channel_name',
		options: { type, index: expr('$(local:ch)') },
	})
	const dbVar = (type: ChannelType) => ({
		variableType: 'feedback' as const,
		variableName: 'db',
		feedbackId: 'fader_text',
		options: { type, index: expr('$(local:ch)') },
	})
	const chVar = { variableType: 'simple' as const, variableName: 'ch', startupValue: 1 }

	for (const type of typesInScope) {
		const label = CHANNEL_TABLE[type].label
		const n = counts.get(type) ?? 0
		const values = Array.from({ length: n }, (_, i) => ({ value: i + 1, name: `${label} ${i + 1}` }))

		// Mute toggle — red when muted, desk colour otherwise
		presets[`mute_${type}`] = {
			type: 'simple',
			name: `${label} mute`,
			style: { text: '$(local:name)', textExpression: false, size: 'auto', color: WHITE, bgcolor: DARK },
			localVariables: [chVar, nameVar(type)],
			feedbacks: [
				{ feedbackId: 'channel_colour', options: { type, index: expr('$(local:ch)'), text: true } },
				{ feedbackId: 'mute', options: { type, index: expr('$(local:ch)') }, style: { bgcolor: RED, color: WHITE } },
			],
			steps: [{ down: [{ actionId: 'mute', options: { type, index: expr('$(local:ch)'), mode: 'toggle' } }], up: [] }],
		}
		sections.push({
			id: `mutes_${type}`,
			name: `Mutes — ${label}s`,
			definitions: [
				{
					id: `mutes_${type}_t`,
					type: 'template',
					name: `${label} mute`,
					presetId: `mute_${type}`,
					templateVariableName: 'ch',
					templateValues: values,
				},
			],
		})

		if (type === 'mute_group') continue

		// Level readout + nudge
		presets[`level_${type}`] = {
			type: 'simple',
			name: `${label} level`,
			style: { text: '$(local:name)\\n$(local:db)', textExpression: false, size: 'auto', color: WHITE, bgcolor: DARK },
			localVariables: [chVar, nameVar(type), dbVar(type)],
			feedbacks: [{ feedbackId: 'channel_colour', options: { type, index: expr('$(local:ch)'), text: true } }],
			steps: [
				{ down: [{ actionId: 'fader', options: { type, index: expr('$(local:ch)'), db: '0', fade: 0 } }], up: [] },
			],
		}
		presets[`up_${type}`] = {
			type: 'simple',
			name: `${label} +1 dB`,
			style: {
				text: '$(local:name)\\n▲ $(local:db)',
				textExpression: false,
				size: 'auto',
				color: WHITE,
				bgcolor: DARK,
			},
			localVariables: [chVar, nameVar(type), dbVar(type)],
			feedbacks: [],
			steps: [
				{
					down: [{ actionId: 'fader_step', options: { type, index: expr('$(local:ch)'), delta: 1, fade: 0 } }],
					up: [],
					500: {
						options: { runWhileHeld: true },
						actions: [{ actionId: 'fader_step', options: { type, index: expr('$(local:ch)'), delta: 1, fade: 0 } }],
					},
				},
			],
		}
		presets[`down_${type}`] = {
			type: 'simple',
			name: `${label} −1 dB`,
			style: {
				text: '$(local:name)\\n▼ $(local:db)',
				textExpression: false,
				size: 'auto',
				color: WHITE,
				bgcolor: DARK,
			},
			localVariables: [chVar, nameVar(type), dbVar(type)],
			feedbacks: [],
			steps: [
				{
					down: [{ actionId: 'fader_step', options: { type, index: expr('$(local:ch)'), delta: -1, fade: 0 } }],
					up: [],
					500: {
						options: { runWhileHeld: true },
						actions: [{ actionId: 'fader_step', options: { type, index: expr('$(local:ch)'), delta: -1, fade: 0 } }],
					},
				},
			],
		}
		sections.push({
			id: `levels_${type}`,
			name: `Faders — ${label}s`,
			definitions: [
				{
					id: `levels_${type}_t`,
					type: 'template',
					name: `${label}: to 0 dB (shows level)`,
					presetId: `level_${type}`,
					templateVariableName: 'ch',
					templateValues: values,
				},
				{
					id: `up_${type}_t`,
					type: 'template',
					name: `${label}: +1 dB`,
					presetId: `up_${type}`,
					templateVariableName: 'ch',
					templateValues: values,
				},
				{
					id: `down_${type}_t`,
					type: 'template',
					name: `${label}: −1 dB`,
					presetId: `down_${type}`,
					templateVariableName: 'ch',
					templateValues: values,
				},
			],
		})
	}

	// ---------------------------------------------------------------- scenes
	const sceneValues = Array.from({ length: 500 }, (_, i) => ({ value: i + 1, name: `Scene ${i + 1}` }))
	presets.scene_recall = {
		type: 'simple',
		name: 'Recall scene',
		style: { text: 'Scene\\n$(local:sc)', textExpression: false, size: 'auto', color: WHITE, bgcolor: DARK },
		localVariables: [{ variableType: 'simple', variableName: 'sc', startupValue: 1 }],
		feedbacks: [
			{ feedbackId: 'scene_current', options: { scene: expr('$(local:sc)') }, style: { bgcolor: GREEN, color: WHITE } },
		],
		steps: [{ down: [{ actionId: 'scene_recall', options: { scene: expr('$(local:sc)') } }], up: [] }],
	}
	presets.scene_go = {
		type: 'simple',
		name: 'GO',
		style: { text: 'GO', size: '24', color: WHITE, bgcolor: GREEN },
		feedbacks: [],
		steps: [{ down: [{ actionId: 'scene_go', options: {} }], up: [] }],
	}
	presets.scene_next = {
		type: 'simple',
		name: 'Next',
		style: { text: 'Next ▶', size: 'auto', color: WHITE, bgcolor: BLUE },
		feedbacks: [],
		steps: [{ down: [{ actionId: 'scene_next', options: {} }], up: [] }],
	}
	presets.scene_prev = {
		type: 'simple',
		name: 'Previous',
		style: { text: '◀ Prev', size: 'auto', color: WHITE, bgcolor: BLUE },
		feedbacks: [],
		steps: [{ down: [{ actionId: 'scene_prev', options: {} }], up: [] }],
	}
	presets.scene_current = {
		type: 'simple',
		name: 'Current scene display',
		style: { text: '$(dlive:scene_current)\\n$(dlive:scene_current_name)', size: 'auto', color: WHITE, bgcolor: DARK },
		feedbacks: [],
		steps: [{ down: [], up: [] }],
	}
	sections.push({
		id: 'scenes',
		name: 'Scenes',
		definitions: [
			{
				id: 'scene_nav',
				type: 'simple',
				name: 'Cue list',
				presets: ['scene_go', 'scene_next', 'scene_prev', 'scene_current'],
			},
			{
				id: 'scene_recall_t',
				type: 'template',
				name: 'Recall scene',
				presetId: 'scene_recall',
				templateVariableName: 'sc',
				templateValues: sceneValues,
			},
		],
	})

	// ---------------------------------------------------------------- console Actions (named)
	if (ctx.actionsMap.length > 0) {
		const ids: string[] = []
		ctx.actionsMap.forEach((e, i) => {
			const id = `console_action_${i}`
			ids.push(id)
			presets[id] = {
				type: 'simple',
				name: e.name,
				style: { text: e.name, size: 'auto', color: BLACK, bgcolor: combineRgb(230, 200, 60) },
				feedbacks: [],
				steps: [{ down: [{ actionId: 'console_action', options: { entry: `${e.cc}/${e.value}` } }], up: [] }],
			}
		})
		sections.push({ id: 'console_actions', name: 'Console Actions', definitions: ids })
	}

	// ---------------------------------------------------------------- status
	presets.status = {
		type: 'simple',
		name: 'Console status',
		style: { text: 'dLive\\n$(dlive:firmware)', size: 'auto', color: WHITE, bgcolor: RED },
		feedbacks: [{ feedbackId: 'connected', options: {}, style: { bgcolor: GREEN, color: WHITE } }],
		steps: [{ down: [{ actionId: 'resync', options: {} }], up: [] }],
	}
	sections.push({ id: 'status', name: 'Status', definitions: ['status'] })

	return { sections, presets }
}
