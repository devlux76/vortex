import { ROOT, stripVortexPrefix, isAllowedVortexArgs, vortexRefusal } from './run.ts'
import type { ToolDef } from './run.ts'
import type { ToolCallRecord } from './run.ts'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'

// --- services ---
export interface ServiceHandle { dir: string, apiPort: number, peerId: string, addrs: string[], proc: any, stateFile: string }
export function freePort (): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close(() => { resolvePromise(port) })
    })
  })
}
export async function readReady (proc: any, timeoutMs = 60000): Promise<any> {
  const reader = proc.stdout.getReader()
  const dec = new TextDecoder()
  let text = ''
  const deadline = Date.now() + timeoutMs
  // One read stays pending across the one-second checks. Starting a new read
  // each time would leave the old one to swallow the chunk carrying "ready".
  let pending: Promise<any> | null = null
  try {
    for (;;) {
      const remain = deadline - Date.now()
      if (remain <= 0) throw new Error('serve not ready in time')
      pending ??= reader.read()
      const chunk: any = await Promise.race([
        pending,
        new Promise(resolve => setTimeout(() => resolve(null), Math.min(remain, 1000))),
      ])
      if (chunk === null) {
        if (proc.exitCode !== null && proc.exitCode !== undefined) {
          throw new Error('serve exited before ready (code ' + proc.exitCode + ')')
        }
        continue
      }
      pending = null
      if (chunk.value) text += dec.decode(chunk.value, { stream: true })
      const line = text.split('\n').find(l => l.includes('"event":"ready"') || l.includes('"event": "ready"'))
      if (line) return JSON.parse(line)
      if (chunk.done) throw new Error('serve stdout closed before ready')
    }
  } finally {
    try { reader.releaseLock() } catch { /* ignore */ }
  }
}
export async function startService (owner: string): Promise<ServiceHandle> {
  const dir = mkdtempSync(join(tmpdir(), `usability-${owner}-`))
  const apiPort = await freePort()
  const proc: any = Bun.spawn(['bun', 'src/cli.ts', 'serve', '--dir', dir, '--name', owner, '--port', String(apiPort)],
    { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
  try {
    const ready = await readReady(proc)
    return { dir, apiPort, peerId: ready.peerId, addrs: ready.addrs, proc, stateFile: join(dir, 'state.json') }
  } catch (e) {
    try { proc.kill('SIGTERM') } catch { /* ignore */ }
    throw e
  }
}
export async function stopService (h: ServiceHandle): Promise<void> {
  try { h.proc.kill('SIGTERM') } catch { /* ignore */ }
  await Promise.race([h.proc.exited, new Promise(r => setTimeout(r, 3000))])
  try { rmSync(h.dir, { recursive: true, force: true }) } catch { /* ignore */ }
}
export function readState (h: ServiceHandle): any {
  return JSON.parse(readFileSync(h.stateFile, 'utf8'))
}
export function dialableAddr (h: ServiceHandle): string {
  const a = h.addrs.find(x => x.startsWith('/ip4/127.0.0.1/tcp/'))
  if (!a) throw new Error('no dialable address')
  return a
}
export function peerIdFromAddr (addr: string): string {
  const m = addr.match(/\/p2p\/([^/]+)$/)
  if (!m) throw new Error('addr has no peer id: ' + addr)
  return m[1]
}

// Run one CLI command against a service dir; returns combined stdout+stderr.
export async function runCli (args: string[], dir: string, timeoutMs = 70000): Promise<string> {
  const proc: any = Bun.spawn(['bun', 'src/cli.ts', ...args, '--dir', dir],
    { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
  const done = proc.exited
  const timeout = new Promise<string>((_, reject) => setTimeout(() => {
    try { proc.kill('SIGTERM') } catch { /* ignore */ }
    reject(new Error('cli timed out: ' + args.join(' ')))
  }, timeoutMs))
  await Promise.race([done, timeout])
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(),
  ])
  return (out + (err ? '\n' + err : '')).trim()
}

// The model's only VORTEX tool.
export function makeVortexTool (aliceDir: string, log: ToolCallRecord[]) {
  return async (args: string): Promise<string> => {
    const tokens = stripVortexPrefix(args)
    const cleaned = tokens.join(' ')
    if (!isAllowedVortexArgs(cleaned)) return vortexRefusal(cleaned)
    const out = await runCli(tokens, aliceDir)
    log.push({ tool: 'vortex', args, output: out, at: Date.now() })
    return out
  }
}

// In-memory notes tool for the control errands.
export function makeNotesTool (log: ToolCallRecord[]) {
  const notes: string[] = []
  const snapshots: { at: number, notes: string[] }[] = []
  const fn = async (args: string): Promise<string> => {
    const at = Date.now()
    let out: string
    const m = args.match(/^(add|list|delete)\s*(.*)$/s)
    if (!m) { out = 'usage: add <text> | list | delete <text|index>' }
    else if (m[1] === 'add' && m[2].trim()) { notes.push(m[2].trim()); out = `added ${notes.length - 1}` }
    else if (m[1] === 'list') { out = notes.map((n, i) => `${i}: ${n}`).join('\n') || '(empty)' }
    else if (m[1] === 'delete' && m[2].trim()) {
      const key = m[2].trim()
      const idx = /^\d+$/.test(key) ? Number(key) : notes.indexOf(key)
      if (idx < 0 || idx >= notes.length) out = 'no such note'
      else { notes.splice(idx, 1); out = 'deleted' }
    } else out = 'usage: add <text> | list | delete <text|index>'
    log.push({ tool: 'notes', args, output: out, at })
    snapshots.push({ at, notes: [...notes] })
    return out
  }
  return { fn, notes, snapshots }
}

// --- typed tools: one function per operation, named arguments ---
// LFM2.5 is trained on calls of the form name(arg="value") against a JSON tool
// list; a command line packed into one string is not that shape.
export const TYPED_VORTEX_SYSTEM = 'You are an agent that talks to another agent over VORTEX. ' +
  'Call one tool at a time and read its result before the next call. ' +
  'To exchange messages with a peer: dial its address, invite its peer ID (the part of the address after /p2p/), ' +
  'then send to that peer ID. A reply arrives later: call wait until it returns a message, ' +
  'then ack.'
export const TYPED_NOTES_SYSTEM = 'Use the note tools to manage a small note list. Call one tool at a time.'
export const TYPED_VORTEX_DEFS: ToolDef[] = [
  { name: 'dial', description: 'Connect to a peer.', parameters: { peer: 'The full address of the peer, starting with /ip4/' } },
  { name: 'invite', description: 'Invite a dialed peer to a conversation.', parameters: { peer: 'The peer ID: the part of the address after /p2p/' } },
  { name: 'send', description: 'Send a message to a peer you invited, once it has accepted.', parameters: { peer: 'The peer ID you invited', text: 'The message' } },
  { name: 'wait', description: 'Wait up to a minute for a message from a peer, then return all unread events.', parameters: {} },
  { name: 'read', description: 'Return unread events without waiting.', parameters: {} },
  { name: 'ack', description: 'Acknowledge everything that wait or read has returned to you.', parameters: {} },
  { name: 'inbox', description: 'List conversations and pending invitations.', parameters: {} },
  { name: 'info', description: 'Show your own peer ID and addresses.', parameters: {} },
]
export const TYPED_NOTES_DEFS: ToolDef[] = [
  { name: 'add_note', description: 'Add one note to the list.', parameters: { text: 'The note' } },
  { name: 'list_notes', description: 'List all notes.', parameters: {} },
  { name: 'delete_note', description: 'Delete one note from the list.', parameters: { text: 'The note to delete' } },
]
// Parses the JSON arguments and checks every declared parameter is present.
export function typedArgs (def: ToolDef, json: string): { values: Record<string, string> } | { error: string } {
  let parsed: any
  try { parsed = JSON.parse(json || '{}') } catch { return { error: JSON.stringify({ error: 'arguments must be a JSON object' }) } }
  const values: Record<string, string> = {}
  for (const name of Object.keys(def.parameters ?? {})) {
    const v = parsed?.[name]
    if (v === undefined || v === null || v === '') return { error: JSON.stringify({ error: `missing argument: ${name}`, needs: def.parameters }) }
    values[name] = typeof v === 'string' ? v : JSON.stringify(v)
  }
  return { values }
}
export function makeTypedVortexTools (aliceDir: string, log: ToolCallRecord[]): Record<string, (args: string) => Promise<string>> {
  const tokensFor: Record<string, (v: Record<string, string>) => string[]> = {
    dial: v => ['dial', '--peer', v.peer],
    invite: v => ['invite', '--peer', v.peer],
    send: v => ['send', '--peer', v.peer, '--text', v.text],
    wait: () => ['wait', '--timeout', '60', '--for', 'message'],
    read: () => ['read'],
    ack: () => ['ack', '--cursor', 'read'],
    inbox: () => ['inbox'],
    info: () => ['info'],
  }
  return Object.fromEntries(TYPED_VORTEX_DEFS.map(def => [def.name, async (args: string) => {
    const a = typedArgs(def, args)
    if ('error' in a) return a.error
    const tokens = tokensFor[def.name](a.values)
    const out = await runCli(tokens, aliceDir)
    log.push({ tool: 'vortex', args: tokens.join(' '), output: out, at: Date.now() })
    return out
  }]))
}
export function makeTypedNotesTools (notes: (args: string) => Promise<string>): Record<string, (args: string) => Promise<string>> {
  const commandFor: Record<string, (v: Record<string, string>) => string> = {
    add_note: v => 'add ' + v.text, list_notes: () => 'list', delete_note: v => 'delete ' + v.text,
  }
  return Object.fromEntries(TYPED_NOTES_DEFS.map(def => [def.name, async (args: string) => {
    const a = typedArgs(def, args)
    return 'error' in a ? a.error : await notes(commandFor[def.name](a.values))
  }]))
}
