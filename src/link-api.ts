/**
 * LinkApi — the one seam between the Companion layer (main/actions/
 * feedbacks/presets) and "however we reach the console".
 *
 * Two implementations:
 *   ConsoleLink (link.ts)            — direct mode: two TCP sockets, own
 *                                      codec, scheduler, probe, fades.
 *   BridgeLink  (bridge/bridgelink.ts) — via the MIDI Bridge Client API v1:
 *                                      the bridge owns the socket, mirror,
 *                                      query-on-ping and fades; this side
 *                                      is a thin lane client.
 */

import type { EventEmitter } from 'node:events'
import type { ChannelRef } from './protocol/channels.js'
import type { ConsoleEvent, Intent, SocketRole } from './protocol/intents.js'
import type { ConsoleState } from './state/model.js'
import type { SubscriptionRegistry } from './state/subscriptions.js'
import type { SyncScope } from './link.js'

export type LinkStatus = 'disconnected' | 'connecting' | 'probing' | 'ok' | 'failure'

export interface LinkEvents {
	changed: [paths: string[]]
	status: [status: LinkStatus, message: string | undefined]
	event: [ev: ConsoleEvent, role: SocketRole]
	log: [level: 'debug' | 'info' | 'warn' | 'error', message: string]
}

/** Diagnostics for the module's status variables — shape shared by both modes. */
export interface LinkDiag {
	getsInFlight: number
	getsMissed: number
	unsupported: string
}

export interface LinkApi extends EventEmitter<LinkEvents> {
	readonly state: ConsoleState
	readonly subscriptions: SubscriptionRegistry
	readonly status: LinkStatus
	readonly statusMessage: string | undefined
	readonly isOk: boolean

	start(): void
	stop(): void
	setBaseChannel(baseChannel: number): void

	/** Encode + deliver an intent. Sets are mirrored optimistically. */
	send(intent: Intent): boolean
	/** Ask for a value; the answer arrives as a state change on `path`. */
	query(intent: Intent, path: string, priority?: 'high' | 'normal' | 'low'): void
	/** Timed dB-linear fade of a strip fader. */
	fadeTo(ref: ChannelRef, toLv: number, durationMs: number): void
	/** Timed fade of a send level (best effort; sends are gated pre-calibration). */
	fadeSend(src: ChannelRef, dst: ChannelRef, fromLv: number, toLv: number, durationMs: number): void
	/** Re-read console state (scope is advisory; bridge mode refetches its mirror). */
	sync(scope: SyncScope): void
	diag(): LinkDiag
}
