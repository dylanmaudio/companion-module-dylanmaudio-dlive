import { describe, expect, it } from 'vitest'
import { syntheticShow } from '../../test/showbuilder.js'
import { parseShowTar } from './parser.js'
import {
	CHUNK_CHARS,
	describeImport,
	extractChunk,
	importedActions,
	importedScenes,
	readImport,
	toImport,
	UploadBuffer,
} from './upload.js'
import { uploadPageHtml } from './uploadpage.js'

/** Chunk a file the way the browser page does: 3-byte-aligned, so each part is valid base64. */
function chunks(buf: Buffer): string[] {
	const raw = (CHUNK_CHARS / 4) * 3
	const out: string[] = []
	for (let i = 0; i < buf.length; i += raw) out.push(buf.subarray(i, i + raw).toString('base64'))
	return out.length ? out : ['']
}

describe('UploadBuffer', () => {
	it('reassembles a multi-part upload and returns nothing until the last part', () => {
		const file = Buffer.alloc(200_000, 7)
		const parts = chunks(file)
		expect(parts.length).toBeGreaterThan(1)
		const b = new UploadBuffer()
		for (let i = 0; i < parts.length - 1; i++) {
			expect(b.add('abc', 'show.tar.gz', i, parts.length, parts[i])).toBeNull()
		}
		const done = b.add('abc', 'show.tar.gz', parts.length - 1, parts.length, parts[parts.length - 1])
		expect(done?.equals(file)).toBe(true)
		expect(b.size).toBe(0) // finished uploads are not kept
	})

	it('accepts parts out of order — a browser may retry one', () => {
		const file = Buffer.from('the quick brown fox'.repeat(4000))
		const parts = chunks(file)
		const b = new UploadBuffer()
		const order = [...parts.keys()].reverse()
		let done: Buffer | null = null
		for (const i of order) done = b.add('x1', 'n', i, parts.length, parts[i])
		expect(done?.equals(file)).toBe(true)
	})

	it('ignores a repeated part rather than doubling it', () => {
		const b = new UploadBuffer()
		expect(b.add('x', 'n', 0, 2, Buffer.from('aaa').toString('base64'))).toBeNull()
		expect(b.add('x', 'n', 0, 2, Buffer.from('zzz').toString('base64'))).toBeNull()
		const out = b.add('x', 'n', 1, 2, Buffer.from('bbb').toString('base64'))
		expect(out?.toString()).toBe('aaabbb')
	})

	it('keeps concurrent uploads apart', () => {
		const b = new UploadBuffer()
		b.add('one', 'a', 0, 2, Buffer.from('AAA').toString('base64'))
		b.add('two', 'b', 0, 2, Buffer.from('XXX').toString('base64'))
		expect(b.add('two', 'b', 1, 2, Buffer.from('YYY').toString('base64'))?.toString()).toBe('XXXYYY')
		expect(b.add('one', 'a', 1, 2, Buffer.from('BBB').toString('base64'))?.toString()).toBe('AAABBB')
	})

	it('refuses a mis-sliced upload rather than returning a truncated file', () => {
		// 'XX' is two bytes, so its base64 carries padding; concatenating that with
		// the next part and decoding would stop dead at the '=' and lose the rest.
		const b = new UploadBuffer()
		expect(() => b.add('bad', 'n', 0, 2, Buffer.from('XX').toString('base64'))).toThrow(/not 3-byte aligned/)
		expect(b.size).toBe(0)
		// the final part is allowed to be padded — that is where the real file ends
		b.add('ok', 'n', 0, 2, Buffer.from('AAA').toString('base64'))
		expect(b.add('ok', 'n', 1, 2, Buffer.from('Z').toString('base64'))?.toString()).toBe('AAAZ')
	})

	it('rejects nonsense addressing instead of allocating for it', () => {
		const b = new UploadBuffer()
		expect(() => b.add('../etc', 'n', 0, 1, '')).toThrow(/Bad upload id/)
		expect(() => b.add('x', 'n', 0, 0, '')).toThrow(/Bad part count/)
		expect(() => b.add('x', 'n', 0, 99999, '')).toThrow(/Bad part count/)
		expect(() => b.add('x', 'n', 3, 2, '')).toThrow(/Bad part number/)
		expect(() => b.add('x', 'n', NaN, 2, '')).toThrow(/Bad part number/)
		b.add('y', 'n', 0, 2, 'AAAA')
		expect(() => b.add('y', 'n', 1, 3, 'AAAA')).toThrow(/Part count changed/)
	})

	it('refuses an upload larger than the cap', () => {
		const b = new UploadBuffer()
		const big = 'A'.repeat(CHUNK_CHARS)
		expect(() => {
			for (let i = 0; i < 1000; i++) b.add('big', 'n', i, 1000, big)
		}).toThrow(/larger than 8 MB/)
		expect(b.size).toBe(0) // and drops what it had, rather than holding it
	})

	it('sweeps an upload that was abandoned mid-file', () => {
		let now = 1_000_000
		const b = new UploadBuffer(() => now)
		b.add('gone', 'n', 0, 2, 'AAAA')
		expect(b.size).toBe(1)
		now += 61_000
		b.sweep()
		expect(b.size).toBe(0)
	})
})

describe('extractChunk', () => {
	it('takes raw base64', () => {
		expect(extractChunk('  QUJD  ')).toBe('QUJD')
	})
	it('takes the JSON fallback the page retries with', () => {
		expect(extractChunk('{"data":"QUJD"}')).toBe('QUJD')
	})
	it('takes a JSON body the host already parsed for us', () => {
		// Companion's own body parser runs first, so application/json arrives as
		// an object even though the host API types `body` as a string.
		expect(extractChunk({ data: 'QUJD' })).toBe('QUJD')
		expect(() => extractChunk({ data: 42 })).toThrow(/no "data"/)
		expect(() => extractChunk({})).toThrow(/no "data"/)
	})
	it('says which way it failed', () => {
		expect(() => extractChunk('')).toThrow(/Empty request body/)
		expect(() => extractChunk(undefined)).toThrow(/Empty request body/)
		expect(() => extractChunk('{oops')).toThrow(/neither base64 nor JSON/)
		expect(() => extractChunk('{"nope":1}')).toThrow(/no "data"/)
	})
})

describe('import round trip', () => {
	it('carries a whole show from upload chunks to scene names and Actions', () => {
		const show = syntheticShow({
			'Show/MIDI/MIDISettings.dat': crlfSettings(),
			'Show/Multifunctions/Band changeover.dat': '2\r\n19f56e64cc3\r\naa,1,\r\n',
		})
		const b = new UploadBuffer()
		const parts = chunks(show)
		let assembled: Buffer | null = null
		for (let i = 0; i < parts.length; i++) assembled = b.add('up1', 'my show.tar.gz', i, parts.length, parts[i])
		expect(assembled).not.toBeNull()

		const parsed = parseShowTar(assembled!, 'my show.tar.gz')
		const stored = JSON.stringify(toImport(parsed, 'my show.tar.gz', new Date('2026-09-02T10:00:00Z')))
		const back = readImport(stored)!

		expect(importedScenes(back)).toEqual(parsed.sceneNames)
		expect(importedActions(back)).toEqual(parsed.actions)
		expect(back.baseChannel).toBe(12)
		expect(describeImport(back)).toBe('my show.tar.gz — 3 scene names, 1 Action (2 Sep 2026)')
	})

	it('treats an unreadable or foreign import as absent rather than throwing', () => {
		expect(readImport('')).toBeNull()
		expect(readImport('not json')).toBeNull()
		expect(readImport('{"v":2,"scenes":[],"actions":[]}')).toBeNull() // a future format
		expect(readImport('{"v":1}')).toBeNull()
		expect(describeImport(null)).toBe('')
	})

	it('drops junk rows inside an otherwise valid import', () => {
		const i = readImport(
			JSON.stringify({
				v: 1,
				name: 'x',
				at: 'not a date',
				scenes: [
					[1, 'Intro'],
					[2, ''],
					['nope', 'Bad'],
				],
				actions: [
					[20, 1, 'Go'],
					[21, 2],
					['x', 3, 'Bad'],
				],
			}),
		)!
		expect([...importedScenes(i)]).toEqual([[1, 'Intro']])
		expect(importedActions(i)).toEqual([
			{ cc: 20, value: 1, name: 'Go' },
			{ cc: 21, value: 2, name: undefined },
		])
		expect(describeImport(i)).toBe('x — 3 scene names, 3 Actions') // no date, and counts are of what was stored
	})
})

describe('upload page', () => {
	it('escapes the connection label instead of letting it write markup', () => {
		const html = uploadPageHtml({ label: '<img src=x onerror=alert(1)>', imported: '', path: '' })
		expect(html).not.toContain('<img src=x')
		expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
	})
	it('offers removal only when something is loaded', () => {
		expect(uploadPageHtml({ label: 'dLive', imported: 'show.tar.gz — 8 scene names, 0 Actions', path: '' })).toContain(
			'id="remove"',
		)
		expect(uploadPageHtml({ label: 'dLive', imported: '', path: '' })).not.toContain('id="remove"')
	})
	it('mentions the path field only when one is set, since the upload wins over it', () => {
		expect(uploadPageHtml({ label: 'dLive', imported: '', path: '/shows/gig.tar.gz' })).toContain('/shows/gig.tar.gz')
		expect(uploadPageHtml({ label: 'dLive', imported: '', path: '' })).not.toContain('takes precedence')
	})
})

function crlfSettings(): string {
	return (
		[
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
		].join('\r\n') + '\r\n'
	)
}
