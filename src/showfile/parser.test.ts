import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { parseShowTar, readShowFile, sceneNameFromDat } from './parser.js'

/**
 * Synthetic dLive shows.
 *
 * These tests used to run against one of Allen & Heath's firmware template
 * shows, checked into this repo. Building the archive here instead keeps
 * someone else's file out of an MIT repo and, more usefully, lets each test
 * say exactly which bytes it is asserting on — the StageBox/Surface split,
 * an unused slot, the 65535 working-state scene.
 *
 * The layout mirrors a firmware 2.03 export byte for byte: ustar entries,
 * CRLF text files, and one nested tar.gz per scene whose .dat opens
 * `01 01 <name> NUL <description> NUL`. Verified against a real template
 * show before that file was removed.
 */

type ShowFiles = Record<string, Buffer | string>

function tar(files: ShowFiles): Buffer {
	const blocks: Buffer[] = []
	for (const [name, content] of Object.entries(files)) {
		const isDir = name.endsWith('/')
		const body = Buffer.isBuffer(content) ? content : Buffer.from(content, 'latin1')
		blocks.push(tarHeader(name, isDir ? 0 : body.length, isDir ? '5' : '0', isDir ? '0000755' : '0000644'))
		if (!isDir) blocks.push(pad(body))
	}
	blocks.push(Buffer.alloc(1024)) // two zero blocks end an archive
	return Buffer.concat(blocks)
}

function tarHeader(name: string, size: number, type: string, mode = '0000644'): Buffer {
	const h = Buffer.alloc(512)
	h.write(name, 0, 100, 'latin1')
	h.write(mode + '\0', 100)
	h.write('0000000\0', 108) // uid
	h.write('0000000\0', 116) // gid
	h.write(size.toString(8).padStart(11, '0') + '\0', 124)
	h.write('00000000000\0', 136) // mtime 0 — keeps the bytes reproducible
	h.write('        ', 148) // checksum reads as blanks while it is summed
	h.write(type, 156)
	h.write('ustar\x0000', 257)
	let sum = 0
	for (const b of h) sum += b
	h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
	return h
}

function pad(body: Buffer): Buffer {
	const rem = body.length % 512
	return rem === 0 ? body : Buffer.concat([body, Buffer.alloc(512 - rem)])
}

/** `01 01 <name> NUL <description> NUL`, then slack — as the console writes it. */
function sceneDat(name: string, description = ''): Buffer {
	return Buffer.concat([Buffer.from([1, 1]), Buffer.from(`${name}\0${description}\0`, 'latin1'), Buffer.alloc(24)])
}

function sceneArchive(side: 'StageBox' | 'Surface', n: number, name: string): Buffer {
	return gzipSync(tar({ [`${side}Scene${String(n).padStart(3, '0')}.dat`]: sceneDat(name) }))
}

const crlf = (...lines: string[]) => lines.join('\r\n') + '\r\n'

/**
 * Scene 1 and 2 are named on both sides (StageBox must win); 3 only on the
 * Surface side (the fallback); 4 is a saved-but-unnamed slot; 65535 is the
 * live working state and 501 is out of range — both must be dropped.
 */
const SCENES: [number, string | null, string | null][] = [
	[1, 'Reset all settings', 'Scene 1'],
	[2, 'Band changeover', 'Scene 2'],
	[3, null, 'Scene 3'],
	[4, '', ''],
	[501, 'Out of range', null],
	[65535, 'Working state', null],
]

function syntheticShow(extra: ShowFiles = {}): Buffer {
	const files: ShowFiles = {
		'Show/': '',
		'Show/MIDI/': '',
		'Show/MIDI/MIDISettings.dat': crlf(
			'3',
			'11',
			'255',
			'255',
			'255',
			'255',
			'255',
			'255',
			'255',
			'255',
			'true',
			'true',
		),
		'Show/QuickName/': '',
		'Show/QuickName/ChannelQuickName.dat': crlf('1', 'Kick', 'Snare', 'HH'),
		'Show/Scenes/': '',
		'Show/Scenes/SceneUpdateFilters.dat': 'not a scene',
	}
	for (const [n, stagebox, surface] of SCENES) {
		const nnn = String(n).padStart(3, '0')
		if (stagebox !== null) files[`Show/Scenes/StageBoxScene${nnn}.tar.gz`] = sceneArchive('StageBox', n, stagebox)
		if (surface !== null) files[`Show/Scenes/SurfaceScene${nnn}.tar.gz`] = sceneArchive('Surface', n, surface)
	}
	return gzipSync(tar({ ...files, ...extra }))
}

describe('show file parser', () => {
	it('reads scene names, quick names and base channel from a show archive', () => {
		const r = parseShowTar(syntheticShow(), 'synthetic')
		// StageBox carries the name the operator typed; Surface only the default "Scene N"
		expect(r.sceneNames.get(1)).toBe('Reset all settings')
		expect(r.sceneNames.get(2)).toBe('Band changeover')
		expect(r.sceneNames.get(3)).toBe('Scene 3') // no StageBox side — fall back
		expect(r.sceneNames.has(4)).toBe(false) // saved but never named
		expect(r.sceneNames.has(501)).toBe(false)
		expect(r.sceneNames.has(65535)).toBe(false) // the live working state, not a scene
		expect(r.sceneNames.size).toBe(3)
		expect([...r.sceneNames.keys()]).toEqual([1, 2, 3]) // ascending, whatever order the tar was in
		expect(r.quickNames).toEqual(['Kick', 'Snare', 'HH'])
		expect(r.baseChannel).toBe(12) // stored 0-indexed as 11
		expect(r.actions).toEqual([]) // format 3 has no Actions table
		expect(r.warnings).toEqual([])
	})

	it('readShowFile works on a path', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dlive-show-'))
		const path = join(dir, 'synthetic.tar.gz')
		writeFileSync(path, syntheticShow())
		expect(readShowFile(path).sceneNames.size).toBe(3)
		expect(() => readShowFile(join(dir, 'nothing.tar.gz'))).toThrow(/No such file/)
	})

	it('rejects non-show archives honestly', () => {
		const r = parseShowTar(Buffer.from('hello'))
		expect(r.warnings[0]).toMatch(/Not a tar/)
	})

	it('says so when a tar is not a dLive show', () => {
		const r = parseShowTar(gzipSync(tar({ 'notes.txt': 'nothing to see' })))
		expect(r.warnings).toEqual(['Archive has no Show/ directory — is this a dLive show file?', 'No scene names found'])
	})

	it('reads the Actions MIDI table out of a firmware 2.1x show archive', () => {
		// format 4 appends "cc,value,id" rows; 255,255,0 is an empty slot
		const r = parseShowTar(
			syntheticShow({
				'Show/MIDI/MIDISettings.dat': crlf(
					'4',
					'11',
					'255',
					'255',
					'255',
					'255',
					'255',
					'255',
					'255',
					'255',
					'true',
					'true',
					'20,2,1783869361347',
					'255,255,0',
				),
				'Show/Multifunctions/Band changeover.dat': '2\r\n19f56e64cc3\r\naa,1,\r\n',
			}),
		)
		expect(r.actions).toEqual([{ cc: 20, value: 2, name: 'Band changeover' }])
		expect(r.sceneNames.size).toBe(3) // the rest of the show still parses
	})

	it('reads the Actions MIDI table from an unpacked firmware 2.1x show directory', () => {
		// synthetic Show/ dir in MIDISettings format 4 (LF endings, as fw 2.1x writes)
		const dir = mkdtempSync(join(tmpdir(), 'dlive-show-'))
		const show = join(dir, 'Show')
		mkdirSync(join(show, 'MIDI'), { recursive: true })
		mkdirSync(join(show, 'Multifunctions'), { recursive: true })
		mkdirSync(join(show, 'Scenes'), { recursive: true })
		writeFileSync(
			join(show, 'MIDI', 'MIDISettings.dat'),
			[
				'4',
				'0',
				'255',
				'255',
				'255',
				'255',
				'255',
				'255',
				'255',
				'255',
				'true',
				'true',
				'20,2,1783869361347',
				'21,5,1783869442272',
				'20,1,999',
				'255,255,0',
				'255,255,0',
				'',
			].join('\n'),
		)
		writeFileSync(join(show, 'Multifunctions', 'Band changeover.dat'), '2\n19f56e64cc3\naa,1,\n')
		writeFileSync(join(show, 'Multifunctions', 'House lights.dat'), '2\n19f56e788e0\naa,2,\n')
		const r = readShowFile(dir)
		expect(r.baseChannel).toBe(1)
		expect(r.actions).toEqual([
			{ cc: 20, value: 1, name: undefined }, // trigger whose Action file is gone
			{ cc: 20, value: 2, name: 'Band changeover' }, // 0x19f56e64cc3 = 1783869361347
			{ cc: 21, value: 5, name: 'House lights' }, // 0x19f56e788e0 = 1783869442272
		])
	})

	it('scene name is NUL-terminated after a 2-byte header', () => {
		expect(sceneNameFromDat(Buffer.from([1, 1, 0x49, 0x6e, 0x74, 0x72, 0x6f, 0, 0, 0]))).toBe('Intro')
		expect(sceneNameFromDat(Buffer.from([1, 1, 0]))).toBeUndefined()
	})
})
