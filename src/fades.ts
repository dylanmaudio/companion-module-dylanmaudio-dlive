/**
 * FadeEngine — timed level ramps, dB-linear, emit-on-change.
 *
 * In direct mode the module owns the ramp loop (in bridge mode the bridge
 * will — `fade` is a bridge-API primitive — and this engine is bypassed).
 * Ramps are keyed by target so a new move on the same target cancels the
 * old one, and each ramp emits at most one message per `stepMs` and only
 * when the LV actually changes, so a 3 s fade is ~60 messages, not 600.
 */

import { LV_TO_DB, MIN_DB, dbToLv, lvToDb } from './protocol/levels.js'

interface Ramp {
	fromDb: number
	toDb: number
	toLv: number
	startAt: number
	endAt: number
	lastLv: number
	lastEmitAt: number
}

const INF_DB = MIN_DB - 6 // −∞ is modelled a little below the lowest finite step

export class FadeEngine {
	private readonly ramps = new Map<string, Ramp>()

	constructor(
		private readonly emit: (key: string, lv: number) => void,
		private readonly stepMs = 50,
	) {}

	/** Start (or replace) a ramp. durationMs ≤ 0 emits the target immediately. */
	start(key: string, fromLv: number, toLv: number, durationMs: number, now: number): void {
		this.ramps.delete(key)
		if (durationMs <= 0 || fromLv === toLv) {
			this.emit(key, toLv)
			return
		}
		this.ramps.set(key, {
			fromDb: dbOf(fromLv),
			toDb: dbOf(toLv),
			toLv,
			startAt: now,
			endAt: now + durationMs,
			lastLv: fromLv,
			lastEmitAt: -Infinity,
		})
	}

	cancel(key: string): void {
		this.ramps.delete(key)
	}

	cancelAll(): void {
		this.ramps.clear()
	}

	isActive(key: string): boolean {
		return this.ramps.has(key)
	}

	get activeCount(): number {
		return this.ramps.size
	}

	tick(now: number): void {
		for (const [key, r] of this.ramps) {
			if (now >= r.endAt) {
				this.ramps.delete(key)
				if (r.lastLv !== r.toLv) this.emit(key, r.toLv)
				continue
			}
			if (now - r.lastEmitAt < this.stepMs) continue
			const t = (now - r.startAt) / (r.endAt - r.startAt)
			const db = r.fromDb + (r.toDb - r.fromDb) * t
			const lv = db <= INF_DB + 0.01 ? 0 : dbToLv(Math.max(db, MIN_DB))
			r.lastEmitAt = now
			if (lv !== r.lastLv) {
				r.lastLv = lv
				this.emit(key, lv)
			}
		}
	}
}

function dbOf(lv: number): number {
	const d = lvToDb(lv)
	return d === null ? INF_DB : d
}

export { LV_TO_DB }
