// Transport list and WebRTC ICE configuration for p2p nodes.
//
// Order of preference: WebRTC (direct, NAT traversal by ICE: STUN, TURN) when
// both sides can use it, WebSockets to reach the relay/rendezvous node, and
// Circuit Relay v2 as WebRTC signaling and as the fallback path. Add a
// transport by appending to the list in buildTransports().
//
// ICE servers come from, in order:
//   VORTEX_P2P_ICE       JSON: [{urls, username?, credential?}, ...]
//   VORTEX_P2P_ICE_FILE  path to JSON: {iceServers: [...], proxyServer?: {...}}
// Default: no ICE servers (host candidates only, enough on one LAN/loopback).
// TURN over TLS on 443 uses a url like "turns:turn.example.org:443?transport=tcp".
// Credentials in these values are never logged.
import './bun-compat.ts'
import { readFileSync } from 'node:fs'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { webSockets } from '@libp2p/websockets'
import type { Transport } from '@libp2p/interface'

export interface IceServer { urls: string | string[], username?: string, credential?: string }
/** node-datachannel (libdatachannel) proxy for ICE-TCP/TURN; see README caveat. */
export interface ProxyServer { type: 'Http' | 'Socks5', ip: string, port: number, username?: string, password?: string }
export interface IceConfig { iceServers: IceServer[], proxyServer?: ProxyServer, iceTransportPolicy?: 'all' | 'relay' }

export function loadIceConfig (env: Record<string, string | undefined> = process.env): IceConfig {
  if (env.VORTEX_P2P_ICE) {
    const servers = JSON.parse(env.VORTEX_P2P_ICE) as unknown
    if (!Array.isArray(servers)) throw new Error('VORTEX_P2P_ICE must be a JSON array of ICE servers')
    return { iceServers: servers.map(checkServer) }
  }
  if (env.VORTEX_P2P_ICE_FILE) {
    const raw = JSON.parse(readFileSync(env.VORTEX_P2P_ICE_FILE, 'utf8')) as Partial<IceConfig>
    return {
      iceServers: (raw.iceServers ?? []).map(checkServer),
      proxyServer: raw.proxyServer,
      iceTransportPolicy: raw.iceTransportPolicy
    }
  }
  return { iceServers: [] }
}

function checkServer (s: unknown): IceServer {
  const v = s as IceServer
  const urls = Array.isArray(v?.urls) ? v.urls : [v?.urls]
  if (urls.length === 0 || !urls.every(u => typeof u === 'string' && /^(stun|stuns|turn|turns):/.test(u))) {
    throw new Error('each ICE server needs urls starting stun:, stuns:, turn: or turns:')
  }
  return v
}

// The WebRTC transport needs node-datachannel's native module; load it lazily
// so a host without it still gets WebSockets + relay.
type WebRTCFactory = (init?: { rtcConfiguration?: unknown }) => (components: any) => Transport
let webrtcFactory: WebRTCFactory | null | undefined

export async function loadWebRTC (): Promise<{ ok: true, factory: WebRTCFactory } | { ok: false, error: string }> {
  if (webrtcFactory === undefined) {
    try {
      webrtcFactory = (await import('@libp2p/webrtc')).webRTC as unknown as WebRTCFactory
    } catch (e) {
      webrtcFactory = null
      return { ok: false, error: (e as Error).message }
    }
  }
  return webrtcFactory ? { ok: true, factory: webrtcFactory } : { ok: false, error: 'WebRTC transport failed to load earlier' }
}

export interface TransportOptions {
  webrtc?: boolean
  ice?: IceConfig
}

export async function buildTransports (opts: TransportOptions = {}): Promise<{ transports: Array<(c: any) => Transport>, webrtc: boolean, webrtcError?: string }> {
  const transports: Array<(c: any) => Transport> = [
    webSockets(),
    circuitRelayTransport()
  ]
  if (opts.webrtc !== true) return { transports, webrtc: false }
  const w = await loadWebRTC()
  if (!w.ok) return { transports, webrtc: false, webrtcError: w.error }
  const ice = opts.ice ?? loadIceConfig()
  // node-datachannel's RTCPeerConnection polyfill spreads unknown keys into
  // libdatachannel's config, which is how proxyServer reaches it.
  transports.unshift(w.factory({ rtcConfiguration: { ...ice } }))
  return { transports, webrtc: true }
}
