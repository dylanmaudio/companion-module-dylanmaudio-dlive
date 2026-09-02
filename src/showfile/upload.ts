/**
 * Show-file upload over the module's own HTTP endpoint.
 *
 * Companion's connection form cannot ask for a file: its ten field types are
 * text, number, dropdown and friends — there is no file picker — and the
 * module process is sandboxed to its own folder, so a typed-in path is
 * usually unreadable anyway. Both problems disappear if the browser hands us
 * the bytes. `handleHttpRequest` lets a module serve a page of its own, so
 * the page below has a real <input type="file"> and the show is parsed
 * in-process from the upload.
 *
 * The file arrives base64 in fixed-size chunks. Two unknowns about the host's
 * body parser force that: its size limit (express defaults to 100 kB, and a
 * show is 0.2–2 MB) and which content types it will parse at all. Small
 * text/plain posts are the one shape every parser handles, and the page falls
 * back to application/json if a chunk comes through empty.
 *
 * What is kept is the *derived* import — scene names and the Actions table —
 * not the archive. It lives in the connection config so it survives a restart
 * without the module holding megabytes or writing to a filesystem it cannot
 * reliably write to.
 */

import type { ShowFileAction, ShowFileResult } from './parser.js'

/** Base64 characters per POST. Comfortably under a 100 kB body limit. */
export const CHUNK_CHARS = 48 * 1024
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
const MAX_UPLOAD_CHARS = Math.ceil((MAX_UPLOAD_BYTES / 3) * 4)
const UPLOAD_TTL_MS = 60_000
/** A show holds at most 500 scenes; anything near that many parts is a bug or an attack. */
const MAX_PARTS = 1024

export interface ShowImport {
	v: 1
	/** Original filename, for the "what is loaded" line */
	name: string
	/** ISO date of the import */
	at: string
	baseChannel?: number
	scenes: [number, string][]
	actions: [number, number, string?][]
}

interface Pending {
	name: string
	parts: Map<number, string>
	total: number
	chars: number
	touched: number
}

/**
 * Reassembles chunked uploads. Parts may arrive in any order; an upload that
 * stops mid-way is swept after UPLOAD_TTL_MS rather than pinning memory.
 */
export class UploadBuffer {
	private readonly pending = new Map<string, Pending>()
	constructor(private readonly now: () => number = Date.now) {}

	get size(): number {
		return this.pending.size
	}

	/** Returns the assembled file once the final part lands, else null. */
	add(id: string, name: string, part: number, total: number, data: string): Buffer | null {
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('Bad upload id')
		if (!Number.isInteger(total) || total < 1 || total > MAX_PARTS) throw new Error('Bad part count')
		if (!Number.isInteger(part) || part < 0 || part >= total) throw new Error('Bad part number')
		this.sweep()
		let p = this.pending.get(id)
		if (!p) {
			p = { name, parts: new Map(), total, chars: 0, touched: this.now() }
			this.pending.set(id, p)
		}
		if (p.total !== total) throw new Error('Part count changed mid-upload')
		p.touched = this.now()
		// Base64 only concatenates cleanly on 3-byte boundaries: a padded or
		// ragged middle chunk would decode to a silently truncated file, which
		// then looks like a corrupt show rather than a bad upload. Refuse it.
		if (part < total - 1 && (data.length % 4 !== 0 || data.includes('='))) {
			this.pending.delete(id)
			throw new Error(`Part ${part + 1} is not 3-byte aligned — the upload would be truncated`)
		}
		if (!p.parts.has(part)) {
			p.chars += data.length
			if (p.chars > MAX_UPLOAD_CHARS) {
				this.pending.delete(id)
				throw new Error(`Show file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`)
			}
			p.parts.set(part, data)
		}
		if (p.parts.size < total) return null
		this.pending.delete(id)
		let b64 = ''
		for (let i = 0; i < total; i++) b64 += p.parts.get(i)
		return Buffer.from(b64, 'base64')
	}

	/** Drop uploads nothing has touched for a minute. */
	sweep(): void {
		const cutoff = this.now() - UPLOAD_TTL_MS
		for (const [id, p] of this.pending) if (p.touched < cutoff) this.pending.delete(id)
	}
}

/**
 * The chunk out of a request body. The page posts raw base64 as text/plain; if
 * the host's parser refuses that content type it retries as JSON, so both
 * shapes have to be understood here.
 *
 * `body` is `unknown` rather than the `string` the host API declares: Companion
 * runs the request through its own body parser first, so an application/json
 * post arrives as an already-parsed object. Taking it at its word crashed the
 * fallback path the first time it ran against a live Companion.
 */
export function extractChunk(body: unknown): string {
	if (body && typeof body === 'object') return dataField(body)
	const raw = typeof body === 'string' ? body.trim() : ''
	if (!raw) throw new Error('Empty request body')
	if (raw.startsWith('{')) {
		let parsed: unknown
		try {
			parsed = JSON.parse(raw)
		} catch {
			throw new Error('Body is neither base64 nor JSON')
		}
		return dataField(parsed)
	}
	return raw
}

function dataField(o: unknown): string {
	const data = (o as { data?: unknown }).data
	if (typeof data !== 'string' || !data.trim()) throw new Error('JSON body has no "data"')
	return data.trim()
}

/** Parsed show → the compact form kept in the connection config. */
export function toImport(r: ShowFileResult, name: string, at: Date): ShowImport {
	return {
		v: 1,
		name,
		at: at.toISOString(),
		baseChannel: r.baseChannel,
		scenes: [...r.sceneNames],
		actions: r.actions.map((a): [number, number, string?] => (a.name ? [a.cc, a.value, a.name] : [a.cc, a.value])),
	}
}

/** Config text → import, or null when absent or unreadable (never throws). */
export function readImport(text: string): ShowImport | null {
	if (!text) return null
	try {
		const i = JSON.parse(text) as ShowImport
		if (i?.v !== 1 || !Array.isArray(i.scenes) || !Array.isArray(i.actions)) return null
		return i
	} catch {
		return null
	}
}

export function importedScenes(i: ShowImport): Map<number, string> {
	return new Map(i.scenes.filter(([n, name]) => Number.isInteger(n) && typeof name === 'string' && name))
}

export function importedActions(i: ShowImport): ShowFileAction[] {
	return i.actions
		.filter(([cc, v]) => Number.isInteger(cc) && Number.isInteger(v))
		.map(([cc, value, name]): ShowFileAction => ({ cc, value, name: name || undefined }))
}

/** "26DM NorthlaneEU.tar.gz — 127 scene names, 9 Actions (2 Sep 2026)" */
export function describeImport(i: ShowImport | null): string {
	if (!i) return ''
	const when = new Date(i.at)
	// Formatted by hand rather than with toLocaleDateString: Companion may bundle
	// a small-ICU Node, where the locale silently falls back and the month name
	// changes underneath us.
	const date = isNaN(when.getTime()) ? '' : ` (${when.getDate()} ${MONTHS[when.getMonth()]} ${when.getFullYear()})`
	return `${i.name} — ${plural(i.scenes.length, 'scene name')}, ${plural(i.actions.length, 'Action')}${date}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' }[c]};`)
}
