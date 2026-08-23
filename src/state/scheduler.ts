/**
 * QueryScheduler — the only thing allowed to send Gets.
 *
 * The console has no subscribe verb and undocumented flow control, so every
 * Get is rationed:
 *
 *   - bounded in-flight window (default 8), FIFO by priority;
 *   - one outstanding request per target path (dedupe);
 *   - a reply is matched by *target path* — an event for that path, whether
 *     or not the value changed — never by timing;
 *   - a Get with no reply in `replyTimeoutMs` is a *miss*; three consecutive
 *     misses for the same op mark that op unsupported for `backoffMs`
 *     (an `inferred` Get the firmware ignores degrades to "no feedback",
 *     not to a connection fault);
 *   - fader pings coalesce per strip on a trailing edge (one Get per burst)
 *     plus a settle Get after the burst ends;
 *   - background polling only touches paths somebody is watching and only
 *     the parameters the desk never announces, round-robin, one per
 *     `pollIntervalMs` when nothing more urgent is queued.
 *
 * No timers of its own: the owner calls `tick(now)` (every ~10 ms) and
 * `onReplyPaths()` as events arrive. Pure enough to unit-test with a fake
 * clock.
 */

import type { Intent, IntentOp } from '../protocol/intents.js'
import type { ChannelRef } from '../protocol/channels.js'
import { channelKey } from '../protocol/channels.js'
import { faderPath } from './model.js'

export type Priority = 'high' | 'normal' | 'low'

export interface SchedulerOptions {
	inFlight: number
	replyTimeoutMs: number
	pingCoalesceMs: number
	settleMs: number
	pollIntervalMs: number
	backoffMs: number
	missesToBackOff: number
}

export const DEFAULT_SCHEDULER_OPTIONS: SchedulerOptions = {
	inFlight: 8,
	replyTimeoutMs: 500,
	pingCoalesceMs: 40,
	settleMs: 250,
	pollIntervalMs: 50,
	backoffMs: 60_000,
	missesToBackOff: 3,
}

export interface QueryRequest {
	intent: Intent
	/** the state path whose event counts as the reply */
	path: string
	priority: Priority
}

interface Pending extends QueryRequest {
	sentAt: number
}

export interface PollTarget {
	intent: Intent
	path: string
}

const PRIORITY_ORDER: Record<Priority, number> = { high: 0, normal: 1, low: 2 }

export class QueryScheduler {
	readonly opts: SchedulerOptions
	private queue: QueryRequest[] = []
	private readonly queued = new Set<string>()
	private readonly pending = new Map<string, Pending>()
	private readonly misses = new Map<IntentOp, number>()
	private readonly backedOff = new Map<IntentOp, number>()
	private readonly pings = new Map<string, { ref: ChannelRef; due: number; settleDue: number | null }>()
	private pollProvider: (() => PollTarget[]) | null = null
	private pollRota: PollTarget[] = []
	private pollIndex = 0
	private pollVersion = -1
	private pollVersionProvider: (() => number) | null = null
	private nextPollAt = 0
	private enabled = false

	public stats = { sent: 0, replied: 0, missed: 0, coalescedPings: 0 }

	constructor(
		private readonly send: (intent: Intent) => void,
		private readonly log: (level: 'debug' | 'info' | 'warn', msg: string) => void,
		opts: Partial<SchedulerOptions> = {},
	) {
		this.opts = { ...DEFAULT_SCHEDULER_OPTIONS, ...opts }
	}

	/** Start/stop issuing Gets (stop on disconnect; pending requests are dropped). */
	setEnabled(on: boolean): void {
		this.enabled = on
		if (!on) {
			this.queue = []
			this.queued.clear()
			this.pending.clear()
			this.pings.clear()
		}
	}

	get isEnabled(): boolean {
		return this.enabled
	}

	/** Background poll rota: the provider is re-read whenever `version()` changes. */
	setPollProvider(provider: () => PollTarget[], version: () => number): void {
		this.pollProvider = provider
		this.pollVersionProvider = version
		this.pollVersion = -1
	}

	isBackedOff(op: IntentOp, now: number): boolean {
		const until = this.backedOff.get(op)
		if (until === undefined) return false
		if (now >= until) {
			this.backedOff.delete(op)
			this.misses.delete(op)
			return false
		}
		return true
	}

	backedOffOps(): IntentOp[] {
		return [...this.backedOff.keys()]
	}

	/** Queue a Get. Duplicate targets (same path) collapse; a higher priority re-sorts. */
	request(req: QueryRequest, now: number): boolean {
		if (!this.enabled) return false
		if (this.isBackedOff(req.intent.op, now)) return false
		if (this.pending.has(req.path)) return false
		if (this.queued.has(req.path)) {
			const existing = this.queue.find((q) => q.path === req.path)
			if (existing && PRIORITY_ORDER[req.priority] < PRIORITY_ORDER[existing.priority]) {
				existing.priority = req.priority
				this.sortQueue()
			}
			return false
		}
		this.queue.push(req)
		this.queued.add(req.path)
		this.sortQueue()
		return true
	}

	private sortQueue(): void {
		// stable sort by priority only; FIFO within a priority
		this.queue = this.queue
			.map((q, i) => ({ q, i }))
			.sort((a, b) => PRIORITY_ORDER[a.q.priority] - PRIORITY_ORDER[b.q.priority] || a.i - b.i)
			.map((x) => x.q)
	}

	/** The desk said a fader moved but not where to. */
	onPing(ref: ChannelRef, now: number): void {
		if (!this.enabled) return
		const key = channelKey(ref)
		const existing = this.pings.get(key)
		if (existing) {
			this.stats.coalescedPings++
			existing.due = now + this.opts.pingCoalesceMs
			existing.settleDue = null
		} else {
			this.pings.set(key, { ref, due: now + this.opts.pingCoalesceMs, settleDue: null })
		}
	}

	/** Events arrived for these paths (changed or not). Resolves matching in-flight Gets. */
	onReplyPaths(paths: Iterable<string>): void {
		for (const p of paths) {
			const pend = this.pending.get(p)
			if (!pend) continue
			this.pending.delete(p)
			this.stats.replied++
			this.misses.delete(pend.intent.op)
		}
	}

	get inFlight(): number {
		return this.pending.size
	}

	get queueLength(): number {
		return this.queue.length
	}

	/** Advance: fire coalesced pings, time out misses, send from the queue, background-poll. */
	tick(now: number): void {
		if (!this.enabled) return

		// 1. pings whose trailing edge has passed → fader Get (+ settle Get later)
		for (const [key, p] of this.pings) {
			if (p.settleDue === null && now >= p.due) {
				this.request(
					{
						intent: { op: 'get_fader', type: p.ref.type, index: p.ref.index },
						path: faderPath(p.ref),
						priority: 'high',
					},
					now,
				)
				p.settleDue = now + this.opts.settleMs
			} else if (p.settleDue !== null && now >= p.settleDue) {
				this.request(
					{
						intent: { op: 'get_fader', type: p.ref.type, index: p.ref.index },
						path: faderPath(p.ref),
						priority: 'normal',
					},
					now,
				)
				this.pings.delete(key)
			}
		}

		// 2. misses
		for (const [path, pend] of this.pending) {
			if (now - pend.sentAt < this.opts.replyTimeoutMs) continue
			this.pending.delete(path)
			this.stats.missed++
			const n = (this.misses.get(pend.intent.op) ?? 0) + 1
			this.misses.set(pend.intent.op, n)
			if (n >= this.opts.missesToBackOff && !this.backedOff.has(pend.intent.op)) {
				this.backedOff.set(pend.intent.op, now + this.opts.backoffMs)
				this.log(
					'info',
					`No reply to ${pend.intent.op} after ${n} attempts — the console may not support this Get. Pausing it for ${Math.round(this.opts.backoffMs / 1000)} s.`,
				)
				this.queue = this.queue.filter((q) => {
					if (q.intent.op !== pend.intent.op) return true
					this.queued.delete(q.path)
					return false
				})
			}
		}

		// 3. send from the queue while the window has room
		while (this.pending.size < this.opts.inFlight && this.queue.length > 0) {
			const req = this.queue.shift() as QueryRequest
			this.queued.delete(req.path)
			this.dispatch(req, now)
		}

		// 4. background poll when idle
		if (this.pending.size < this.opts.inFlight && this.queue.length === 0 && now >= this.nextPollAt) {
			const target = this.nextPollTarget(now)
			if (target) {
				this.dispatch({ ...target, priority: 'low' }, now)
				this.nextPollAt = now + this.opts.pollIntervalMs
			}
		}
	}

	private dispatch(req: QueryRequest, now: number): void {
		if (this.pending.has(req.path)) return
		this.pending.set(req.path, { ...req, sentAt: now })
		this.stats.sent++
		this.send(req.intent)
	}

	private nextPollTarget(now: number): PollTarget | null {
		if (!this.pollProvider || !this.pollVersionProvider) return null
		const v = this.pollVersionProvider()
		if (v !== this.pollVersion) {
			this.pollVersion = v
			this.pollRota = this.pollProvider()
			this.pollIndex = 0
		}
		if (this.pollRota.length === 0) return null
		for (let tries = 0; tries < this.pollRota.length; tries++) {
			const t = this.pollRota[this.pollIndex]
			this.pollIndex = (this.pollIndex + 1) % this.pollRota.length
			if (this.pending.has(t.path) || this.isBackedOff(t.intent.op, now)) continue
			return t
		}
		return null
	}
}
