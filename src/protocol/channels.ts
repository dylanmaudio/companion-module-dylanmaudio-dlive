/**
 * Channel addressing — docs/protocol.md §2.
 *
 * Every dLive strip is (MIDI channel = base + offset, 7-bit address).
 * The base channel is per-console and undetectable, so nothing in this
 * file is allowed to assume a value for it: every function takes `baseN`
 * (0-indexed base MIDI channel) explicitly.
 */

export const CHANNEL_TYPES = [
	'input',
	'mono_group',
	'stereo_group',
	'mono_aux',
	'stereo_aux',
	'mono_matrix',
	'stereo_matrix',
	'mono_fx_send',
	'stereo_fx_send',
	'fx_return',
	'main',
	'dca',
	'mute_group',
	'ufx_send',
	'ufx_return',
] as const

export type ChannelType = (typeof CHANNEL_TYPES)[number]

export interface ChannelTypeInfo {
	/** MIDI channel offset from the base channel */
	offset: number
	/** first 7-bit address of the type */
	start: number
	count: number
	label: string
	/** A&H's own short prefix for default strip names ("Ip 1", "Aux 3", …) */
	prefix: string
}

export const CHANNEL_TABLE: Record<ChannelType, ChannelTypeInfo> = {
	input: { offset: 0, start: 0x00, count: 128, label: 'Input', prefix: 'Ip' },
	mono_group: { offset: 1, start: 0x00, count: 62, label: 'Mono Group', prefix: 'Grp' },
	stereo_group: { offset: 1, start: 0x40, count: 31, label: 'Stereo Group', prefix: 'StGrp' },
	mono_aux: { offset: 2, start: 0x00, count: 62, label: 'Mono Aux', prefix: 'Aux' },
	stereo_aux: { offset: 2, start: 0x40, count: 31, label: 'Stereo Aux', prefix: 'StAux' },
	mono_matrix: { offset: 3, start: 0x00, count: 62, label: 'Mono Matrix', prefix: 'Mtx' },
	stereo_matrix: { offset: 3, start: 0x40, count: 31, label: 'Stereo Matrix', prefix: 'StMtx' },
	mono_fx_send: { offset: 4, start: 0x00, count: 16, label: 'Mono FX Send', prefix: 'FXSnd' },
	stereo_fx_send: { offset: 4, start: 0x10, count: 16, label: 'Stereo FX Send', prefix: 'StFXSnd' },
	fx_return: { offset: 4, start: 0x20, count: 16, label: 'FX Return', prefix: 'FXRtn' },
	main: { offset: 4, start: 0x30, count: 6, label: 'Main', prefix: 'Main' },
	dca: { offset: 4, start: 0x36, count: 24, label: 'DCA', prefix: 'DCA' },
	mute_group: { offset: 4, start: 0x4e, count: 8, label: 'Mute Group', prefix: 'MGrp' },
	ufx_send: { offset: 4, start: 0x56, count: 8, label: 'UFX Send', prefix: 'UFXSnd' },
	ufx_return: { offset: 4, start: 0x5e, count: 8, label: 'UFX Return', prefix: 'UFXRtn' },
}

/** Types that can be the destination of a send level (§3.8). */
export const SEND_DESTINATION_TYPES: readonly ChannelType[] = [
	'mono_aux',
	'stereo_aux',
	'mono_fx_send',
	'stereo_fx_send',
	'mono_matrix',
	'stereo_matrix',
	'ufx_send',
]

/** Types that can be the source of a send level (§3.8). */
export const SEND_SOURCE_TYPES: readonly ChannelType[] = [
	'input',
	'mono_group',
	'stereo_group',
	'fx_return',
	'ufx_return',
]

/** Destinations of an input → mix assign (§3.9). */
export const MIX_ASSIGN_DESTINATION_TYPES: readonly ChannelType[] = [
	'mono_group',
	'stereo_group',
	'mono_aux',
	'stereo_aux',
	'mono_matrix',
	'stereo_matrix',
]

/** Types that have a fader (everything except mute groups). */
export const FADER_TYPES: readonly ChannelType[] = CHANNEL_TYPES.filter((t) => t !== 'mute_group')

/** Types that can be assigned to a DCA or mute group. */
export const ASSIGNABLE_TYPES: readonly ChannelType[] = CHANNEL_TYPES.filter((t) => t !== 'dca' && t !== 'mute_group')

/** Types with a PEQ (§3.3). */
export const PEQ_TYPES: readonly ChannelType[] = [
	'input',
	'mono_group',
	'stereo_group',
	'mono_aux',
	'stereo_aux',
	'mono_matrix',
	'stereo_matrix',
	'fx_return',
	'main',
]

export interface ChannelRef {
	type: ChannelType
	/** 1-based, as shown on the console */
	index: number
}

export function isChannelType(value: unknown): value is ChannelType {
	return typeof value === 'string' && value in CHANNEL_TABLE
}

export function assertChannel(ref: ChannelRef): void {
	const info = CHANNEL_TABLE[ref.type]
	if (!info) throw new RangeError(`unknown channel type ${String(ref.type)}`)
	if (!Number.isInteger(ref.index) || ref.index < 1 || ref.index > info.count) {
		throw new RangeError(`${info.label} index must be 1..${info.count}, got ${ref.index}`)
	}
}

/** (MIDI channel 0-15, address 0-127) for a strip. */
export function midiAddress(baseN: number, ref: ChannelRef): { n: number; addr: number } {
	assertChannel(ref)
	const info = CHANNEL_TABLE[ref.type]
	return { n: (baseN + info.offset) & 0x0f, addr: info.start + ref.index - 1 }
}

/**
 * Inverse: which strip does (MIDI channel, address) name, for this base?
 * Returns undefined if the channel is outside base..base+4 or the address
 * does not belong to any type on that channel.
 */
export function resolveAddress(baseN: number, n: number, addr: number): ChannelRef | undefined {
	const offset = (n - baseN + 16) & 0x0f
	if (offset > 4) return undefined
	for (const type of CHANNEL_TYPES) {
		const info = CHANNEL_TABLE[type]
		if (info.offset !== offset) continue
		if (addr >= info.start && addr < info.start + info.count) {
			return { type, index: addr - info.start + 1 }
		}
	}
	return undefined
}

/** Stable key for maps: "input/12". */
export function channelKey(ref: ChannelRef): string {
	return `${ref.type}/${ref.index}`
}

export function parseChannelKey(key: string): ChannelRef | undefined {
	const [type, idx] = key.split('/')
	const index = Number(idx)
	if (!isChannelType(type) || !Number.isInteger(index)) return undefined
	const ref = { type, index }
	try {
		assertChannel(ref)
	} catch {
		return undefined
	}
	return ref
}

/** A&H-style default strip name, used until the desk tells us otherwise. */
export function defaultName(ref: ChannelRef): string {
	return `${CHANNEL_TABLE[ref.type].prefix} ${ref.index}`
}

// ---------------------------------------------------------------- preamps

export const SOCKET_BANKS = ['mixrack', 'dx12', 'dx34'] as const
export type SocketBank = (typeof SOCKET_BANKS)[number]

export const SOCKET_BANK_TABLE: Record<SocketBank, { start: number; count: number; label: string }> = {
	mixrack: { start: 0x00, count: 64, label: 'MixRack socket' },
	dx12: { start: 0x40, count: 32, label: 'DX 1/2 socket' },
	dx34: { start: 0x60, count: 32, label: 'DX 3/4 socket' },
}

export interface SocketRef {
	bank: SocketBank
	/** 1-based */
	socket: number
}

export function isSocketBank(value: unknown): value is SocketBank {
	return typeof value === 'string' && value in SOCKET_BANK_TABLE
}

export function socketAddress(ref: SocketRef): number {
	const info = SOCKET_BANK_TABLE[ref.bank]
	if (!info) throw new RangeError(`unknown socket bank ${String(ref.bank)}`)
	if (!Number.isInteger(ref.socket) || ref.socket < 1 || ref.socket > info.count) {
		throw new RangeError(`${info.label} must be 1..${info.count}, got ${ref.socket}`)
	}
	return info.start + ref.socket - 1
}

export function resolveSocket(addr: number): SocketRef | undefined {
	for (const bank of SOCKET_BANKS) {
		const info = SOCKET_BANK_TABLE[bank]
		if (addr >= info.start && addr < info.start + info.count) {
			return { bank, socket: addr - info.start + 1 }
		}
	}
	return undefined
}

export function socketKey(ref: SocketRef): string {
	return `${ref.bank}/${ref.socket}`
}

// ---------------------------------------------------------------- colours

export const COLOURS = ['off', 'red', 'green', 'yellow', 'blue', 'purple', 'lt_blue', 'white'] as const
export type Colour = (typeof COLOURS)[number]

export function colourByte(c: Colour): number {
	const i = COLOURS.indexOf(c)
	if (i < 0) throw new RangeError(`unknown colour ${String(c)}`)
	return i
}

export function colourFromByte(b: number): Colour {
	return COLOURS[b & 0x07]
}

/** Companion button colours for each desk colour (bg, text). */
export const COLOUR_STYLE: Record<Colour, { bg: number; text: number }> = {
	off: { bg: 0x202020, text: 0xffffff },
	red: { bg: 0xd02020, text: 0xffffff },
	green: { bg: 0x20a040, text: 0xffffff },
	yellow: { bg: 0xe0c020, text: 0x000000 },
	blue: { bg: 0x2040d0, text: 0xffffff },
	purple: { bg: 0x8030c0, text: 0xffffff },
	lt_blue: { bg: 0x30b0e0, text: 0x000000 },
	white: { bg: 0xf0f0f0, text: 0x000000 },
}
