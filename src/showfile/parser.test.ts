import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseShowTar, readShowFile, sceneNameFromDat } from './parser.js'

const here = dirname(fileURLToPath(import.meta.url))
const FOH = join(here, '..', '..', 'fixtures', 'showfiles', 'FoH-template-fw2.03.tar.gz')

describe('show file parser', () => {
	it('reads scene names, quick names and base channel from a firmware template show', () => {
		const r = parseShowTar(readFileSync(FOH), 'FoH')
		// the StageBox side carries the operator's name; the Surface side only the default "Scene N"
		expect(r.sceneNames.get(1)).toBe('Reset all settings')
		expect(r.sceneNames.get(2)).toBe('C1500 Strip Assign')
		expect(r.sceneNames.get(8)).toBe('Reset MIDI')
		expect(r.sceneNames.has(65535)).toBe(false)
		expect(r.sceneNames.size).toBe(8)
		expect(r.quickNames.slice(0, 3)).toEqual(['Kick', 'Snare', 'HH'])
		expect(r.baseChannel).toBe(12)
		expect(r.warnings).toEqual([])
	})
	it('readShowFile works on a path', () => {
		expect(readShowFile(FOH).sceneNames.size).toBe(8)
		expect(() => readShowFile('/nope/nothing.tar.gz')).toThrow(/No such file/)
	})
	it('rejects non-show archives honestly', () => {
		const r = parseShowTar(Buffer.from('hello'))
		expect(r.warnings[0]).toMatch(/Not a tar/)
	})
	it('reads the Actions MIDI table from a firmware 2.1x-style show directory', () => {
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

	it('older shows (format 3, no Actions table) yield an empty actions list', () => {
		const r = parseShowTar(readFileSync(FOH), 'FoH')
		expect(r.actions).toEqual([])
	})

	it('scene name is NUL-terminated after a 2-byte header', () => {
		expect(sceneNameFromDat(Buffer.from([1, 1, 0x49, 0x6e, 0x74, 0x72, 0x6f, 0, 0, 0]))).toBe('Intro')
		expect(sceneNameFromDat(Buffer.from([1, 1, 0]))).toBeUndefined()
	})
})
