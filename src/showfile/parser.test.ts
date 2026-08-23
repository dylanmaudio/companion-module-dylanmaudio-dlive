import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
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
		expect(r.sceneNames.get(8)).toBe('Scene 500')
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
	it('scene name is NUL-terminated after a 2-byte header', () => {
		expect(sceneNameFromDat(Buffer.from([1, 1, 0x49, 0x6e, 0x74, 0x72, 0x6f, 0, 0, 0]))).toBe('Intro')
		expect(sceneNameFromDat(Buffer.from([1, 1, 0]))).toBeUndefined()
	})
})
