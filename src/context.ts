import type { LogLevel } from '@companion-module/base'
import type { ActionMapEntry, ModuleConfig } from './config.js'
import type { ConsoleLink } from './link.js'

/** What actions/feedbacks/presets need from the instance — keeps them testable without Companion. */
export interface ModuleContext {
	readonly link: ConsoleLink
	readonly config: ModuleConfig
	readonly actionsMap: ActionMapEntry[]
	log(level: LogLevel, message: string): void
	reloadShowFile(): Promise<void>
	resync(): void
}
