/**
 * dLive show-file reader.
 *
 * A dLive show is a gzipped tar of a `Show/` directory (the firmware's
 * template shows, and what the console writes to USB). Most of it is
 * CRLF text; what we want:
 *
 *   Show/Scenes/SurfaceSceneNNN.tar.gz   → SurfaceSceneNNN.dat, bytes: 01 01 <name>\0 …
 *                                          NNN is the scene number (65535 = the
 *                                          unsaved working state, skipped)
 *   Show/QuickName/ChannelQuickName.dat  → "1\r\nKick\r\nSnare\r\n…" (quick-name list,
 *                                          not per-channel — exposed as a hint only)
 *   Show/MIDI/MIDISettings.dat           → "3\r\n11\r\n…" second line = base MIDI
 *                                          channel, 0-indexed
 *
 * There is no Get-Scene-Name over MIDI, so this file is the only source of
 * scene names. Format knowledge comes from firmware 2.03 template shows;
 * a user's Director/console export is assumed to match — mismatches are
 * reported, never guessed around.
 *
 * Pure Node: zlib + a minimal tar walker. Also accepts an already-unpacked
 * Show directory.
 */

import { gunzipSync } from 'node:zlib'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface ShowFileResult {
	sceneNames: Map<number, string>
	quickNames: string[]
	/** 1-indexed, as shown on the console; undefined if not found */
	baseChannel: number | undefined
	warnings: string[]
	source: string
}

interface TarEntry {
	name: string
	data: Buffer
}

/** Walk a (possibly gzipped) tar buffer. */
export function readTar(buf: Buffer): TarEntry[] {
	let data = buf
	if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) data = gunzipSync(data)
	const entries: TarEntry[] = []
	let off = 0
	while (off + 512 <= data.length) {
		const header = data.subarray(off, off + 512)
		if (header.every((b) => b === 0)) break
		let name = cstr(header.subarray(0, 100))
		const size = parseInt(cstr(header.subarray(124, 136)).trim() || '0', 8)
		const type = header[156]
		const magic = cstr(header.subarray(257, 262))
		if (magic === 'ustar') {
			const prefix = cstr(header.subarray(345, 500))
			if (prefix) name = `${prefix}/${name}`
		}
		off += 512
		const body = data.subarray(off, off + size)
		off += Math.ceil(size / 512) * 512
		if (type === 0x4c /* 'L' GNU longname */) {
			const longName = cstr(body)
			// next header carries the real entry; patch its name
			const next = readTarOne(data, off)
			if (next) {
				entries.push({ name: longName, data: next.data })
				off = next.next
			}
			continue
		}
		if (type === 0 || type === 0x30 /* '0' */) entries.push({ name, data: Buffer.from(body) })
	}
	return entries
}

function readTarOne(data: Buffer, off: number): { data: Buffer; next: number } | null {
	if (off + 512 > data.length) return null
	const header = data.subarray(off, off + 512)
	const size = parseInt(cstr(header.subarray(124, 136)).trim() || '0', 8)
	off += 512
	const body = data.subarray(off, off + size)
	return { data: Buffer.from(body), next: off + Math.ceil(size / 512) * 512 }
}

function cstr(b: Uint8Array): string {
	let end = b.indexOf(0)
	if (end < 0) end = b.length
	return Buffer.from(b.subarray(0, end)).toString('latin1')
}

const SCENE_RE = /(?:^|\/)SurfaceScene(\d+)\.tar\.gz$/
const SCENE_DAT_RE = /(?:^|\/)SurfaceScene(\d+)\.dat$/

/** Scene name from a SurfaceSceneNNN.dat: 2-byte header, then a NUL-terminated name. */
export function sceneNameFromDat(dat: Buffer): string | undefined {
	if (dat.length < 3) return undefined
	const end = dat.indexOf(0, 2)
	const raw = dat.subarray(2, end < 0 ? Math.min(dat.length, 66) : end)
	const name = raw.toString('latin1').trim()
	return name || undefined
}

export function parseShowTar(buf: Buffer, source = 'show'): ShowFileResult {
	const res: ShowFileResult = { sceneNames: new Map(), quickNames: [], baseChannel: undefined, warnings: [], source }
	const entries = readTar(buf)
	if (entries.length === 0) {
		res.warnings.push('Not a tar archive (or empty)')
		return res
	}
	let sawShow = false
	for (const e of entries) {
		if (e.name.includes('Show/')) sawShow = true
		const m = SCENE_RE.exec(e.name)
		if (m) {
			const scene = Number(m[1])
			if (scene < 1 || scene > 500) continue
			try {
				const inner = readTar(e.data)
				const dat = inner.find((x) => SCENE_DAT_RE.test(x.name)) ?? inner[0]
				const name = dat ? sceneNameFromDat(dat.data) : undefined
				if (name) res.sceneNames.set(scene, name)
				else res.warnings.push(`Scene ${scene}: no name found in ${e.name}`)
			} catch (err) {
				res.warnings.push(`Scene ${scene}: ${(err as Error).message}`)
			}
			continue
		}
		if (/(?:^|\/)ChannelQuickName\.dat$/.test(e.name)) {
			res.quickNames = e.data
				.toString('latin1')
				.split(/\r?\n/)
				.slice(1)
				.map((s) => s.trim())
				.filter(Boolean)
			continue
		}
		if (/(?:^|\/)MIDISettings\.dat$/.test(e.name)) {
			const lines = e.data.toString('latin1').split(/\r?\n/)
			const n = Number(lines[1])
			if (Number.isInteger(n) && n >= 0 && n <= 15) res.baseChannel = n + 1
			else res.warnings.push('MIDISettings.dat: could not read the base MIDI channel')
		}
	}
	if (!sawShow) res.warnings.push('Archive has no Show/ directory — is this a dLive show file?')
	if (res.sceneNames.size === 0) res.warnings.push('No scene names found')
	return res
}

/** Read a show from a path: .tar.gz/.dlive/any tar, or an unpacked directory containing Show/. */
export function readShowFile(path: string): ShowFileResult {
	if (!existsSync(path)) throw new Error(`No such file or folder: ${path}`)
	const st = statSync(path)
	if (st.isDirectory()) return parseShowDirectory(path)
	return parseShowTar(readFileSync(path), path)
}

function parseShowDirectory(dir: string): ShowFileResult {
	const showDir = existsSync(join(dir, 'Show')) ? join(dir, 'Show') : dir
	const res: ShowFileResult = {
		sceneNames: new Map(),
		quickNames: [],
		baseChannel: undefined,
		warnings: [],
		source: dir,
	}
	const scenes = join(showDir, 'Scenes')
	if (existsSync(scenes)) {
		for (const f of readdirSync(scenes)) {
			const m = SCENE_RE.exec(f)
			if (!m) continue
			const scene = Number(m[1])
			if (scene < 1 || scene > 500) continue
			try {
				const inner = readTar(readFileSync(join(scenes, f)))
				const dat = inner.find((x) => SCENE_DAT_RE.test(x.name)) ?? inner[0]
				const name = dat ? sceneNameFromDat(dat.data) : undefined
				if (name) res.sceneNames.set(scene, name)
			} catch (err) {
				res.warnings.push(`Scene ${scene}: ${(err as Error).message}`)
			}
		}
	} else {
		res.warnings.push(`No Scenes folder under ${showDir}`)
	}
	const qn = join(showDir, 'QuickName', 'ChannelQuickName.dat')
	if (existsSync(qn))
		res.quickNames = readFileSync(qn, 'latin1')
			.split(/\r?\n/)
			.slice(1)
			.map((s) => s.trim())
			.filter(Boolean)
	const midi = join(showDir, 'MIDI', 'MIDISettings.dat')
	if (existsSync(midi)) {
		const n = Number(readFileSync(midi, 'latin1').split(/\r?\n/)[1])
		if (Number.isInteger(n) && n >= 0 && n <= 15) res.baseChannel = n + 1
	}
	if (res.sceneNames.size === 0) res.warnings.push('No scene names found')
	return res
}
