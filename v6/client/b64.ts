// Base64 and base64url, built only on btoa/atob (globals in Bun, Node 18+
// with a global flag, and every browser), so one implementation serves the
// hub (which must run without node_modules, build.test.ts), the p2p layer
// (which must run in a browser, Moon), and the bridge.
//
// The names are deliberately methods on namespaces, never bare `toString` or
// `fromString`: a missing import of those names silently resolves to
// Object.prototype.toString and produced '[object Undefined]' twice on #11.
// A missing b64url import fails loudly instead.

/** Standard base64 with padding ('base64pad' in uint8arrays, Buffer 'base64'). */
export const b64pad = {
  encode (bytes: Uint8Array): string {
    let bin = ''
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
    return btoa(bin)
  },
  /** Accepts both alphabets, with or without padding. */
  decode (s: string): Uint8Array {
    const std = s.replace(/-/g, '+').replace(/_/g, '/')
    const padded = std.length % 4 === 0 ? std : std + '='.repeat(4 - (std.length % 4))
    const bin = atob(padded)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
}

/** URL-safe base64 without padding (uint8arrays 'base64url', Buffer 'base64url'). */
export const b64url = {
  encode (bytes: Uint8Array): string {
    return b64pad.encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  },
  decode: b64pad.decode
}
