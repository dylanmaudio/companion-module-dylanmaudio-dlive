import type { CompanionStaticUpgradeScript } from '@companion-module/base'
import type { ModuleConfig } from './config.js'

/**
 * Upgrade scripts run in order when a config from an older module version
 * is loaded. None yet — v0.x has no predecessors. Migration from
 * `allenheath-dlive-ilive` is planned (see docs/roadmap.md) and will land here.
 */
export const UpgradeScripts: CompanionStaticUpgradeScript<ModuleConfig, undefined>[] = []
