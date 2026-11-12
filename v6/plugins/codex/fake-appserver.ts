#!/usr/bin/env bun
// Test fixture: a stand-in for `codex app-server proxy` (stdio JSON-RPC, JSONL,
// no "jsonrpc" field). Implements initialize / initialized / thread/read /
// turn/start and appends every request it receives to $FAKE_LOG.
// Behaviour per request from $FAKE_MODE_FILE (else "ok"):
//   ok | rpc-error | disconnect | no-turn
// Known chats: $FAKE_THREADS (comma list); anything else is "thread not found".
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

const log = process.env.FAKE_LOG!
const threads = new Set((process.env.FAKE_THREADS ?? '').split(',').filter(Boolean))
const record = (entry: unknown): void => appendFileSync(log, JSON.stringify(entry) + '\n')
const mode = (): string => {
  const f = process.env.FAKE_MODE_FILE
  return f !== undefined && existsSync(f) ? readFileSync(f, 'utf8').trim() : 'ok'
}
const send = (obj: unknown): void => { process.stdout.write(JSON.stringify(obj) + '\n') }

let initialized = false
let sawInitialize = false
let turnCounter = 0
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  buf += chunk
  let i: number
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (line.trim().length === 0) continue
    const msg = JSON.parse(line)
    record({ pid: process.pid, method: msg.method, id: msg.id, params: msg.params })
    if (msg.method === 'initialize') { sawInitialize = true; send({ id: msg.id, result: { userAgent: 'fake-codex' } }); continue }
    if (msg.method === 'initialized') { initialized = true; continue }
    if (!sawInitialize || !initialized) { send({ id: msg.id, error: { code: -32002, message: 'Not initialized' } }); continue }
    if (msg.method === 'thread/read') {
      const id = msg.params?.threadId
      if (threads.has(id)) send({ id: msg.id, result: { thread: { id, turns: [] } } })
      else send({ id: msg.id, error: { code: -32600, message: `thread not found: ${id}` } })
      continue
    }
    if (msg.method === 'turn/start') {
      const m = mode()
      const id = msg.params?.threadId
      if (m === 'disconnect') process.exit(0) // dies with the request unanswered
      if (m === 'rpc-error') { send({ id: msg.id, error: { code: -32603, message: `internal error on thread ${id}` } }); continue }
      if (!threads.has(id)) { send({ id: msg.id, error: { code: -32600, message: `thread not found: ${id}` } }); continue }
      if (m === 'no-turn') { send({ id: msg.id, result: {} }); continue }
      send({ id: msg.id, result: { turn: { id: `turn-${process.pid}-${++turnCounter}`, status: 'inProgress', items: [] } } })
      continue
    }
    send({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } })
  }
})
