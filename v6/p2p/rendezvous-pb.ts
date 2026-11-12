// Minimal protobuf codec for the libp2p rendezvous protocol messages
// (libp2p/specs rendezvous/README.md, "Protobuf"). Only varint and
// length-delimited wire types occur in these messages.

export const MessageType = { REGISTER: 0, REGISTER_RESPONSE: 1, UNREGISTER: 2, DISCOVER: 3, DISCOVER_RESPONSE: 4 } as const
export type MessageType = number
export const Status = {
  OK: 0, E_INVALID_NAMESPACE: 100, E_INVALID_SIGNED_PEER_RECORD: 101, E_INVALID_TTL: 102,
  E_INVALID_COOKIE: 103, E_NOT_AUTHORIZED: 200, E_INTERNAL_ERROR: 300, E_UNAVAILABLE: 400
} as const
export type Status = number

export interface Register { ns?: string, signedPeerRecord?: Uint8Array, ttl?: number }
export interface RegisterResponse { status?: Status, statusText?: string, ttl?: number }
export interface Unregister { ns?: string }
export interface Discover { ns?: string, limit?: number, cookie?: Uint8Array }
export interface DiscoverResponse { registrations: Register[], cookie?: Uint8Array, status?: Status, statusText?: string }
export interface Message {
  type?: MessageType
  register?: Register
  registerResponse?: RegisterResponse
  unregister?: Unregister
  discover?: Discover
  discoverResponse?: DiscoverResponse
}

// ---- writer ----
class W {
  parts: number[] = []
  varint (n: number): void {
    if (n < 0 || !Number.isSafeInteger(n)) throw new Error('varint out of range')
    while (n > 0x7f) { this.parts.push((n % 128) | 0x80); n = Math.floor(n / 128) }
    this.parts.push(n)
  }
  tag (field: number, wire: number): void { this.varint(field * 8 + wire) }
  u (field: number, v: number | undefined): void { if (v !== undefined) { this.tag(field, 0); this.varint(v) } }
  b (field: number, v: Uint8Array | undefined): void {
    if (v === undefined) return
    this.tag(field, 2); this.varint(v.length); for (const x of v) this.parts.push(x)
  }
  s (field: number, v: string | undefined): void { if (v !== undefined) this.b(field, new TextEncoder().encode(v)) }
  done (): Uint8Array { return Uint8Array.from(this.parts) }
}

const encRegister = (m: Register): Uint8Array => { const w = new W(); w.s(1, m.ns); w.b(2, m.signedPeerRecord); w.u(3, m.ttl); return w.done() }
const encRegisterResponse = (m: RegisterResponse): Uint8Array => { const w = new W(); w.u(1, m.status); w.s(2, m.statusText); w.u(3, m.ttl); return w.done() }
const encUnregister = (m: Unregister): Uint8Array => { const w = new W(); w.s(1, m.ns); return w.done() }
const encDiscover = (m: Discover): Uint8Array => { const w = new W(); w.s(1, m.ns); w.u(2, m.limit); w.b(3, m.cookie); return w.done() }
function encDiscoverResponse (m: DiscoverResponse): Uint8Array {
  const w = new W()
  for (const r of m.registrations) w.b(1, encRegister(r))
  w.b(2, m.cookie); w.u(3, m.status); w.s(4, m.statusText)
  return w.done()
}

export function encodeMessage (m: Message): Uint8Array {
  const w = new W()
  w.u(1, m.type)
  if (m.register) w.b(2, encRegister(m.register))
  if (m.registerResponse) w.b(3, encRegisterResponse(m.registerResponse))
  if (m.unregister) w.b(4, encUnregister(m.unregister))
  if (m.discover) w.b(5, encDiscover(m.discover))
  if (m.discoverResponse) w.b(6, encDiscoverResponse(m.discoverResponse))
  return w.done()
}

// ---- reader ----
type Field = { n: number, v: number } | { n: number, b: Uint8Array }

function * fields (buf: Uint8Array): Generator<Field> {
  let i = 0
  const varint = (): number => {
    let n = 0; let mul = 1
    for (;;) {
      if (i >= buf.length) throw new Error('truncated varint')
      const x = buf[i++]!
      n += (x & 0x7f) * mul
      if ((x & 0x80) === 0) return n
      mul *= 128
      if (mul > 2 ** 56) throw new Error('varint too long')
    }
  }
  while (i < buf.length) {
    const key = varint(); const n = Math.floor(key / 8); const wire = key % 8
    if (wire === 0) yield { n, v: varint() }
    else if (wire === 2) {
      const len = varint()
      if (i + len > buf.length) throw new Error('truncated field')
      yield { n, b: buf.subarray(i, i + len) }; i += len
    } else if (wire === 1) i += 8
    else if (wire === 5) i += 4
    else throw new Error(`unsupported wire type ${wire}`)
  }
}

const str = (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(b)

function decRegister (buf: Uint8Array): Register {
  const m: Register = {}
  for (const f of fields(buf)) {
    if ('b' in f && f.n === 1) m.ns = str(f.b)
    else if ('b' in f && f.n === 2) m.signedPeerRecord = f.b.slice()
    else if ('v' in f && f.n === 3) m.ttl = f.v
  }
  return m
}
function decRegisterResponse (buf: Uint8Array): RegisterResponse {
  const m: RegisterResponse = {}
  for (const f of fields(buf)) {
    if ('v' in f && f.n === 1) m.status = f.v
    else if ('b' in f && f.n === 2) m.statusText = str(f.b)
    else if ('v' in f && f.n === 3) m.ttl = f.v
  }
  return m
}
function decUnregister (buf: Uint8Array): Unregister {
  const m: Unregister = {}
  for (const f of fields(buf)) if ('b' in f && f.n === 1) m.ns = str(f.b)
  return m
}
function decDiscover (buf: Uint8Array): Discover {
  const m: Discover = {}
  for (const f of fields(buf)) {
    if ('b' in f && f.n === 1) m.ns = str(f.b)
    else if ('v' in f && f.n === 2) m.limit = f.v
    else if ('b' in f && f.n === 3) m.cookie = f.b.slice()
  }
  return m
}
function decDiscoverResponse (buf: Uint8Array): DiscoverResponse {
  const m: DiscoverResponse = { registrations: [] }
  for (const f of fields(buf)) {
    if ('b' in f && f.n === 1) m.registrations.push(decRegister(f.b))
    else if ('b' in f && f.n === 2) m.cookie = f.b.slice()
    else if ('v' in f && f.n === 3) m.status = f.v
    else if ('b' in f && f.n === 4) m.statusText = str(f.b)
  }
  return m
}

export function decodeMessage (buf: Uint8Array): Message {
  const m: Message = {}
  for (const f of fields(buf)) {
    if ('v' in f && f.n === 1) m.type = f.v
    else if ('b' in f && f.n === 2) m.register = decRegister(f.b)
    else if ('b' in f && f.n === 3) m.registerResponse = decRegisterResponse(f.b)
    else if ('b' in f && f.n === 4) m.unregister = decUnregister(f.b)
    else if ('b' in f && f.n === 5) m.discover = decDiscover(f.b)
    else if ('b' in f && f.n === 6) m.discoverResponse = decDiscoverResponse(f.b)
  }
  return m
}
