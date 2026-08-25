/**
 * dLive show-file reader.
 *
 * A dLive show is a gzipped tar of a `Show/` directory (the firmware's
 * template shows, and what the console writes to USB). Most of it is
 * CRLF text; what we want:
 *
 *   Show/Scenes/StageBoxSceneNNN.tar.gz  → StageBoxSceneNNN.dat, bytes: 01 01 <name>\0 …
 *                                          NNN is the scene number (65535 = the
 *                                          unsaved working state, skipped). The
 *                                          MixRack-side file carries the name the
 *                                          operator typed; the Surface-side file
 *                                          (SurfaceSceneNNN) only holds the default
 *                                          "Scene N" and is the fallback. An empty
 *                                          name = an unused slot.
 *   Show/QuickName/ChannelQuickName.dat  → "1\r\nKick\r\nSnare\r\n…" (quick-name list,
 *                                          not per-channel — exposed as a hint only)
 *   Show/MIDI/MIDISettings.dat           → "3\r\n11\r\n…" second line = base MIDI
 *                                          channel, 0-indexed. Format 4 (firmware
 *                                          ~2.1x) appends the Actions MIDI Recall
 *                                          table: one "cc,value,id" line per
 *                                          assigned trigger (255,255,0 = empty slot)
 *   Show/Multifunctions/<Name>.dat        → one file per console Action; the
 *                                          filename is the Action's name and line 2
 *                                          is its unique id in hex — joined with the
 *                                          MIDISettings triggers, this yields the
 *                                          complete named Actions map
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

export interface ShowFileAction {
	cc: number
	value: number
	/** Action name from Show/Multifunctions/<Name>.dat; undefined when the id has no file */
	name: string | undefined
}

export interface ShowFileResult {
	sceneNames: Map<number, string>
	quickNames: string[]
	/** 1-indexed, as shown on the console; undefined if not found */
	baseChannel: number | undefined
	/** Actions with a MIDI Recall trigger (MIDISettings format 4+, firmware ~2.1x) */
	actions: ShowFileAction[]
	warnings: string[]
	source: string
}

/** Accumulates MIDISettings triggers + Multifunctions ids, joined at the end. */
class ActionsTable {
	private triggers: { cc: number; value: number; id: bigint }[] = []
	private names = new Map<bigint, string>()
	parseMidiSettings(text: string): void {
		for (const ln of text.split(/\r?\n/)) {
			const m = /^(\d{1,3}),(\d{1,3}),(\d+)$/.exec(ln.trim())
			if (!m) continue
			const cc = Number(m[1])
			const value = Number(m[2])
			if (cc > 127 || value > 127) continue // 255,255,0 = empty slot
			this.triggers.push({ cc, value, id: BigInt(m[3]) })
		}
	}
	addMultifunction(filename: string, data: Buffer): void {
		const base = filename.replace(/\.dat$/i, '')
		const lines = data.toString('latin1').split(/\r?\n/)
		if (lines.length >= 2 && /^[0-9a-f]{6,16}$/i.test(lines[1].trim())) {
			this.names.set(BigInt('0x' + lines[1].trim()), base)
		}
	}
	joined(): ShowFileAction[] {
		return this.triggers
			.map((t) => ({ cc: t.cc, value: t.value, name: this.names.get(t.id) }))
			.sort((a, b) => a.cc - b.cc || a.value - b.value)
	}
}

const MULTIFUNCTION_RE = /(?:^|\/)Multifunctions\/([^/]+\.dat)$/

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

const SCENE_RE = /(?:^|\/)(StageBox|Surface)Scene(\d+)\.tar\.gz$/
const SCENE_DAT_RE = /(?:^|\/)(?:StageBox|Surface)Scene(\d+)\.dat$/

/** Collect names from both sides; StageBox wins over Surface for the same scene. */
class SceneNames {
	private readonly stagebox = new Map<number, string>()
	private readonly surface = new Map<number, string>()
	public unnamed = 0
	add(side: string, scene: number, name: string | undefined): void {
		if (!name) {
			this.unnamed++
			return
		}
		;(side === 'StageBox' ? this.stagebox : this.surface).set(scene, name)
	}
	merged(): Map<number, string> {
		const out = new Map(this.surface)
		for (const [k, v] of this.stagebox) out.set(k, v)
		return new Map([...out.entries()].sort((a, b) => a[0] - b[0]))
	}
}

function sceneNameFromArchive(buf: Buffer): string | undefined {
	const inner = readTar(buf)
	const dat = inner.find((x) => SCENE_DAT_RE.test(x.name)) ?? inner[0]
	return dat ? sceneNameFromDat(dat.data) : undefined
}

/** Scene name from a SurfaceSceneNNN.dat: 2-byte header, then a NUL-terminated name. */
export function sceneNameFromDat(dat: Buffer): string | undefined {
	if (dat.length < 3) return undefined
	const end = dat.indexOf(0, 2)
	const raw = dat.subarray(2, end < 0 ? Math.min(dat.length, 66) : end)
	const name = raw.toString('latin1').trim()
	return name || undefined
}

export function parseShowTar(buf: Buffer, source = 'show'): ShowFileResult {
	const res: ShowFileResult = {
		sceneNames: new Map(),
		quickNames: [],
		baseChannel: undefined,
		actions: [],
		warnings: [],
		source,
	}
	const actions = new ActionsTable()
	const entries = readTar(buf)
	if (entries.length === 0) {
		res.warnings.push('Not a tar archive (or empty)')
		return res
	}
	let sawShow = false
	const names = new SceneNames()
	for (const e of entries) {
		if (e.name.includes('Show/')) sawShow = true
		const m = SCENE_RE.exec(e.name)
		if (m) {
			const scene = Number(m[2])
			if (scene < 1 || scene > 500) continue
			try {
				names.add(m[1], scene, sceneNameFromArchive(e.data))
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
			const text = e.data.toString('latin1')
			const n = Number(text.split(/\r?\n/)[1])
			if (Number.isInteger(n) && n >= 0 && n <= 15) res.baseChannel = n + 1
			else res.warnings.push('MIDISettings.dat: could not read the base MIDI channel')
			actions.parseMidiSettings(text)
			continue
		}
		const mf = MULTIFUNCTION_RE.exec(e.name)
		if (mf) actions.addMultifunction(mf[1], e.data)
	}
	res.sceneNames = names.merged()
	res.actions = actions.joined()
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
		actions: [],
		warnings: [],
		source: dir,
	}
	const actions = new ActionsTable()
	const scenes = join(showDir, 'Scenes')
	if (existsSync(scenes)) {
		const names = new SceneNames()
		for (const f of readdirSync(scenes)) {
			const m = SCENE_RE.exec(f)
			if (!m) continue
			const scene = Number(m[2])
			if (scene < 1 || scene > 500) continue
			try {
				names.add(m[1], scene, sceneNameFromArchive(readFileSync(join(scenes, f))))
			} catch (err) {
				res.warnings.push(`Scene ${scene}: ${(err as Error).message}`)
			}
		}
		res.sceneNames = names.merged()
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
		const text = readFileSync(midi, 'latin1')
		const n = Number(text.split(/\r?\n/)[1])
		if (Number.isInteger(n) && n >= 0 && n <= 15) res.baseChannel = n + 1
		actions.parseMidiSettings(text)
	}
	const mfDir = join(showDir, 'Multifunctions')
	if (existsSync(mfDir)) {
		for (const f of readdirSync(mfDir)) {
			if (f.endsWith('.dat')) actions.addMultifunction(f, readFileSync(join(mfDir, f)))
		}
	}
	res.actions = actions.joined()
	if (res.sceneNames.size === 0) res.warnings.push('No scene names found')
	return res
}
