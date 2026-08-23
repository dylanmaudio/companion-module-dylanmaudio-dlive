/**
 * Transport — the one seam between "bytes" and "a place bytes go".
 *
 * Direct mode (v1) is two TCP sockets. Bridge mode (v2) will be a
 * WebSocket client of MIDI Bridge. Everything above this interface —
 * codec, state, scheduler, actions, feedbacks — must not know which.
 */

import { EventEmitter } from 'node:events'
import { InstanceStatus } from '@companion-module/base'
import { TCPHelper } from '@companion-module/base'
import type { SocketRole } from '../protocol/intents.js'

export interface TransportEvents {
	data: [role: SocketRole, bytes: Buffer]
	connect: [role: SocketRole]
	disconnect: [role: SocketRole, reason: string]
	error: [role: SocketRole, err: Error]
}

export interface ConsoleTransport extends EventEmitter<TransportEvents> {
	start(): void
	stop(): void
	/** Returns false if the socket for that role is not connected. */
	send(role: SocketRole, bytes: ArrayLike<number>): boolean
	isConnected(role: SocketRole): boolean
	/** Which role actually carries `role` (surface traffic may ride the MixRack socket). */
	routeFor(role: SocketRole): SocketRole
	describe(): string
}

export interface TcpTransportConfig {
	host: string
	port: number
	/** optional second endpoint; when absent, surface-role messages go to the MixRack socket */
	surfaceHost?: string
	surfacePort?: number
}

export class TcpTransport extends EventEmitter<TransportEvents> implements ConsoleTransport {
	private mixrack: TCPHelper | null = null
	private surface: TCPHelper | null = null
	private connected: Record<SocketRole, boolean> = { mixrack: false, surface: false }
	private stopped = true

	constructor(private readonly cfg: TcpTransportConfig) {
		super()
	}

	get hasSurfaceSocket(): boolean {
		return !!this.cfg.surfaceHost
	}

	routeFor(role: SocketRole): SocketRole {
		return role === 'surface' && !this.hasSurfaceSocket ? 'mixrack' : role
	}

	describe(): string {
		const s = this.hasSurfaceSocket ? ` + surface ${this.cfg.surfaceHost}:${this.cfg.surfacePort ?? 51328}` : ''
		return `mixrack ${this.cfg.host}:${this.cfg.port}${s}`
	}

	start(): void {
		this.stop()
		this.stopped = false
		this.mixrack = this.open('mixrack', this.cfg.host, this.cfg.port)
		if (this.hasSurfaceSocket) {
			this.surface = this.open('surface', this.cfg.surfaceHost as string, this.cfg.surfacePort ?? 51328)
		}
	}

	stop(): void {
		this.stopped = true
		for (const role of ['mixrack', 'surface'] as const) {
			const h = role === 'mixrack' ? this.mixrack : this.surface
			if (h) {
				h.removeAllListeners()
				h.destroy()
			}
			if (this.connected[role]) {
				this.connected[role] = false
				this.emit('disconnect', role, 'stopped')
			}
		}
		this.mixrack = null
		this.surface = null
	}

	private open(role: SocketRole, host: string, port: number): TCPHelper {
		const h = new TCPHelper(host, port, { reconnect: true, reconnect_interval: 2000 })
		h.on('connect', () => {
			if (this.stopped) return
			this.connected[role] = true
			this.emit('connect', role)
		})
		h.on('data', (buf) => {
			if (!this.stopped) this.emit('data', role, buf)
		})
		h.on('error', (err) => {
			if (!this.stopped) this.emit('error', role, err)
		})
		h.on('status_change', (status, message) => {
			if (this.stopped) return
			if (status !== InstanceStatus.Ok && this.connected[role]) {
				this.connected[role] = false
				this.emit('disconnect', role, message ?? status)
			}
		})
		h.on('end', () => {
			if (this.stopped) return
			if (this.connected[role]) {
				this.connected[role] = false
				this.emit('disconnect', role, 'closed by console')
			}
		})
		return h
	}

	send(role: SocketRole, bytes: ArrayLike<number>): boolean {
		const target = this.routeFor(role)
		const h = target === 'mixrack' ? this.mixrack : this.surface
		if (!h || !this.connected[target]) return false
		return h.send(Buffer.from(Array.from(bytes)))
	}

	isConnected(role: SocketRole): boolean {
		return this.connected[this.routeFor(role)]
	}
}

/** In-memory transport for tests: what the module sends is captured; tests inject console bytes. */
export class FakeTransport extends EventEmitter<TransportEvents> implements ConsoleTransport {
	public sent: { role: SocketRole; bytes: number[] }[] = []
	private up: Record<SocketRole, boolean> = { mixrack: false, surface: false }
	constructor(private readonly withSurface = false) {
		super()
	}
	start(): void {
		/* tests call connect() explicitly */
	}
	stop(): void {
		for (const role of ['mixrack', 'surface'] as const) {
			if (this.up[role]) {
				this.up[role] = false
				this.emit('disconnect', role, 'stopped')
			}
		}
	}
	connect(role: SocketRole = 'mixrack'): void {
		this.up[role] = true
		this.emit('connect', role)
	}
	drop(role: SocketRole = 'mixrack', reason = 'test'): void {
		this.up[role] = false
		this.emit('disconnect', role, reason)
	}
	receive(bytes: ArrayLike<number>, role: SocketRole = 'mixrack'): void {
		this.emit('data', role, Buffer.from(Array.from(bytes)))
	}
	send(role: SocketRole, bytes: ArrayLike<number>): boolean {
		const target = this.routeFor(role)
		if (!this.up[target]) return false
		this.sent.push({ role: target, bytes: Array.from(bytes) })
		return true
	}
	isConnected(role: SocketRole): boolean {
		return this.up[this.routeFor(role)]
	}
	routeFor(role: SocketRole): SocketRole {
		return role === 'surface' && !this.withSurface ? 'mixrack' : role
	}
	describe(): string {
		return 'fake'
	}
}
