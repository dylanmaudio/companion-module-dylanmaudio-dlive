/**
 * The golden fixtures are the authority for both codecs (this one and the
 * Python one in MIDI Bridge). Every case must pass; a failing case means
 * either the codec is wrong or the fixture needs a hardware capture to
 * justify changing it — never silently edit the fixture to make this green.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DliveDecoder } from './decode.js'
import { encode, fromHex, toHex } from './encode.js'
import type { Intent } from './intents.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', 'fixtures')

interface TxCase {
	id: string
	tier: string
	socket: string
	base_channel: number
	intent: Intent
	hex: string
}
interface RxCase {
	id: string
	tier: string
	base_channel: number
	hex: string
	chunks?: string[]
	events: unknown[]
}

const tx = JSON.parse(readFileSync(join(root, 'tx.json'), 'utf8')) as { cases: TxCase[] }
const rx = JSON.parse(readFileSync(join(root, 'rx.json'), 'utf8')) as { cases: RxCase[] }

describe('tx fixtures → encode()', () => {
	it('has cases', () => expect(tx.cases.length).toBeGreaterThan(50))
	for (const c of tx.cases) {
		it(`${c.id} [${c.tier}]`, () => {
			expect(toHex(encode(c.base_channel - 1, c.intent))).toBe(c.hex)
		})
	}
})

describe('rx fixtures → decode()', () => {
	it('has cases', () => expect(rx.cases.length).toBeGreaterThan(30))
	for (const c of rx.cases) {
		it(`${c.id} [${c.tier}]`, () => {
			const dec = new DliveDecoder(c.base_channel - 1)
			const chunks = c.chunks ? c.chunks.map(fromHex) : [fromHex(c.hex)]
			if (c.chunks) expect(chunks.flat()).toEqual(fromHex(c.hex))
			const events = chunks.flatMap((ch) => dec.feed(ch)).concat(dec.flush())
			expect(events).toEqual(c.events)
		})
	}
	it('every rx case decodes identically byte-at-a-time', () => {
		for (const c of rx.cases) {
			const dec = new DliveDecoder(c.base_channel - 1)
			const events = fromHex(c.hex)
				.flatMap((b) => dec.feed([b]))
				.concat(dec.flush())
			expect(events, c.id).toEqual(c.events)
		}
	})
})
