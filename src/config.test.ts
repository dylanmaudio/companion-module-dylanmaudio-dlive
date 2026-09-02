import { describe, expect, it } from 'vitest'
import { GetConfigFields, normaliseConfig } from './config.js'
import { toImport } from './showfile/upload.js'

const validImport = JSON.stringify(
	toImport(
		{ sceneNames: new Map([[1, 'Intro']]), quickNames: [], baseChannel: 12, actions: [], warnings: [], source: 'x' },
		'gig.tar.gz',
		new Date('2026-09-02T00:00:00Z'),
	),
)

/** The static-text paragraph that introduces the show file section. */
function showBlurb(showImport: string): string {
	const field = GetConfigFields({ label: 'dLive', showImport }).find((f) => f.id === 'infoShow')
	return (field as { value: string }).value
}

describe('show import in the connection config', () => {
	it('keeps an import it cannot read, rather than silently discarding it', () => {
		// Dropping it here would lose the scene names with no trace; reloadShowFile
		// and the config page report the damage instead.
		expect(normaliseConfig({ showImport: 'not json' }).showImport).toBe('not json')
		expect(normaliseConfig({ showImport: validImport }).showImport).toBe(validImport)
	})

	it('refuses only an absurdly large one', () => {
		// A 500-scene show with a full Actions table is around 15 kB.
		expect(normaliseConfig({ showImport: 'x'.repeat(400 * 1024) }).showImport).toHaveLength(400 * 1024)
		expect(normaliseConfig({ showImport: 'x'.repeat(600 * 1024) }).showImport).toBe('')
	})

	it('says which of the three states the show file is in', () => {
		expect(showBlurb(validImport)).toContain('gig.tar.gz — 1 scene name, 0 Actions')
		expect(showBlurb('')).toContain('Scene names exist only in the show file')
		expect(showBlurb('not json')).toContain('could not be read')
	})

	it('points at this connection’s own page, escaping the label into the URL', () => {
		const field = GetConfigFields({ label: 'FOH dLive', showImport: '' }).find((f) => f.id === 'infoShow')
		expect((field as { value: string }).value).toContain('href="/instance/FOH%20dLive/"')
	})

	it('offers no direct-console fields — this module is bridge-only', () => {
		const ids = GetConfigFields().map((f) => f.id)
		for (const gone of ['transport', 'host', 'port', 'surfaceHost', 'baseChannel', 'syncScope']) {
			expect(ids).not.toContain(gone)
		}
		expect(ids).toContain('bridgeHost')
	})
})
