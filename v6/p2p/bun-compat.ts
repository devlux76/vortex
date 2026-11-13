// Bun compatibility shim for @libp2p/websockets listeners.
//
// The listener creates an http.Server that never listens (a net.Server owns
// the port and hands it upgrades) and, on close(), awaits that http.Server's
// 'close' event. Node emits 'close' when a non-listening server is closed;
// Bun 1.4.4 does not, so libp2p's stop() hangs forever on any node with a
// WebSocket listener. This restores Node's behaviour for that one case.
// Remove once Bun emits 'close' (probe: http.createServer().on('close', ...).close()).
import http from 'node:http'

const FLAG = Symbol.for('vortex.p2p.bunHttpCloseShim')

export function installBunHttpCloseShim (): void {
  if (typeof Bun === 'undefined') return
  const proto = http.Server.prototype as unknown as Record<symbol, unknown> & { close: (cb?: (err?: Error) => void) => http.Server }
  if (proto[FLAG] === true) return
  const original = proto.close
  proto.close = function (this: http.Server, cb?: (err?: Error) => void): http.Server {
    if (this.listening) return original.call(this, cb)
    const result = original.call(this, cb)
    queueMicrotask(() => this.emit('close'))
    return result
  }
  proto[FLAG] = true
}

installBunHttpCloseShim()
