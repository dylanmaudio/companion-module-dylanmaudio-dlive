/**
 * Synthetic dLive shows, for tests that need a real show archive.
 *
 * The show-file tests used to run against one of Allen & Heath's firmware
 * template shows, checked into this MIT repo. Building the archive here
 * instead keeps someone else's file out of the repo and, more usefully, lets
 * each test say exactly which bytes it is asserting on — the StageBox/Surface
 * split, an unused slot, the 65535 working-state scene.
 *
 * The layout mirrors a firmware 2.03 export byte for byte: ustar entries,
 * CRLF text files, and one nested tar.gz per scene whose .dat opens
 * `01 01 <name> NUL <description> NUL`. Verified against a real template show
 * before that file was removed, and the archives this emits unpack with
 * system tar.
 */

import { gzipSync } from 'node:zlib'

export type ShowFiles = Record<string, Buffer | string>

export function tar(files: ShowFiles): Buffer {
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

export const crlf = (...lines: string[]): string => lines.join('\r\n') + '\r\n'

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

export function syntheticShow(extra: ShowFiles = {}): Buffer {
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
