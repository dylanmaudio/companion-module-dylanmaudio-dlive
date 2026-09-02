import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { crlf, syntheticShow, tar } from '../../test/showbuilder.js'
import { parseShowTar, readShowFile, sceneNameFromDat } from './parser.js'

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
