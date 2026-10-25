// Usability harness: measures whether a small model can use VORTEX.
// Usage: bun bench/usability/run.ts --base-url <OpenAI-compatible /v1 URL> --model <name> [--runs <n, default 10>] [--request-timeout-s <seconds, default 600>]
// [--max-tokens <n, default 4096>] [--temperature <t, default 0.2>] [--errand-timeout-s <seconds, default 1800>] [--transcript-dir <dir>]
// [--tools <string|typed>] [--top-k <n>] [--repeat-penalty <x>] [--call-history <openai|lfm>]
// Do NOT run against real models in unit tests; the test drives the loop with a stubbed model.
//
// Per run: two scratch `bun src/cli.ts serve` services (alice + bob) in fresh
// temp dirs on free ports. Bob is scripted (no model): accepts any invitation
// and answers the first message with a random 6-digit code. The model plays
// alice through one tool, vortex(args), plus two control errands with an
// in-memory notes(args) tool. Scores come from the services' own state.
//
// Choice notes (obvious defaults): control errands mirror the VORTEX errand's
// shape (same number of required tool calls, similar prompt length) with an
// in-memory notes list (add/list/delete); their six steps are the analogous
// add/list/delete/re-list/report/within-limits checks from tool state.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'

export const ROOT = resolve(import.meta.dir, '..', '..')
const SKILL_PATH = join(ROOT, 'skills', 'vortex', 'SKILL.md')
export const QUESTION = 'What is the code?'
export const MAX_TOOL_CALLS = 25
export const ERRAND_TIMEOUT_MS = 10 * 60 * 1000
export const DEFAULT_REQUEST_TIMEOUT_S = 600
export const DEFAULT_MAX_TOKENS = 4096
export const DEFAULT_TEMPERATURE = 0.2
export const DEFAULT_ERRAND_TIMEOUT_S = 1800
/** Message sent back after a length-truncated empty turn, asking once more. */
export const CUTOFF_RETRY = 'Your reply was cut off before you answered. Reply with a tool call or your final answer now, without long reasoning.'
/** Tool output kept per transcript turn; the rest is cut off in the file. */
export const TRANSCRIPT_OUTPUT_CHARS = 4000

const errMsg = (e: unknown): string =>
  (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 500)

// `usage` describes the single free-text `args` string. A tool with `parameters`
// (name -> description, all required strings) is offered as a function with
// named arguments instead, and receives them as a JSON object string.
export interface ToolDef { name: string, description: string, usage?: string, parameters?: Record<string, string> }
export interface ToolCallRecord { tool: string, args: string, output: string, at: number }
export interface ModelRequest { system: string, errand: string, messages: any[] }
export type CallModel = (req: ModelRequest, tools: ToolDef[]) => Promise<{ toolCalls: { name: string, args: string }[], content: string, finishReason?: string | null, reasoning?: string }>

// --- skill sections (read from file at run time) ---
export function extractSection (skill: string, heading: string): string {
  const start = skill.indexOf('## ' + heading)
  if (start < 0) throw new Error('skill section missing: ' + heading)
  const rest = skill.slice(start)
  const next = rest.indexOf('\n## ', 1)
  return (next < 0 ? rest : rest.slice(0, next)).trim()
}
export function buildSystemPrompt (): string {
  const skill = readFileSync(SKILL_PATH, 'utf8')
  return extractSection(skill, 'Meet and exchange') + '\n\n' + extractSection(skill, 'Waiting for a reply')
}

// --- arg handling for the vortex tool ---
export function splitArgs (input: string): string[] {
  const out: string[] = []
  let cur = '', quote: string | null = null
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (quote) {
      if (c === quote) { quote = null; continue }
      if (c === '\\' && quote === '"' && i + 1 < input.length) { cur += input[++i]; continue }
      cur += c
      continue
    }
    if (c === '"' || c === "'") { quote = c; continue }
    if (/\s/.test(c)) { if (cur) { out.push(cur); cur = '' } continue }
    cur += c
  }
  if (cur) out.push(cur)
  return out
}
export function isAllowedVortexArgs (args: string): boolean {
  if (args.includes('--dir')) return false
  return !/[;|&`$><]/.test(args)
}

const VORTEX_EXAMPLE = 'dial --peer /ip4/127.0.0.1/tcp/7800/p2p/<peer id>'

/**
 * Normalize a model-issued vortex command the way skills/vortex/SKILL.md
 * teaches it: drop an optional leading `bun src/cli.ts`, and remove any
 * `--dir <value>` pair (the harness always supplies its own --dir).
 * Returns tokens, so quoted multi-word values stay intact.
 */
export function stripVortexPrefix (input: string): string[] {
  const tokens = splitArgs(input)
  let i = 0
  if (tokens[0] === 'bun' && tokens[1] === 'src/cli.ts') i = 2
  const out: string[] = []
  for (; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--dir') { i++; continue }
    if (t.startsWith('--dir=')) continue
    out.push(t)
  }
  return out
}

/** Explain a refusal: exactly what was found, plus one valid example. */
export function vortexRefusal (args: string): string {
  const found: string[] = []
  if (args.includes('--dir')) found.push(`'--dir'`)
  const chars = [...new Set([...args].filter(c => /[;|&`$><]/.test(c)))]
  for (const c of chars) found.push(`'${c}'`)
  return `refused: found ${found.join(' and ')}. Use plain args, for example: ${VORTEX_EXAMPLE}`
}

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
function typedArgs (def: ToolDef, json: string): { values: Record<string, string> } | { error: string } {
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

// --- generic agent loop ---
export interface TranscriptToolCall { name: string, args: string }
export interface TranscriptTurn {
  assistant: string
  toolCalls: TranscriptToolCall[]
  toolOutputs: string[]
  requestSeconds: number
  /** Model thinking, capped at 4000 chars; never sent back in the history. */
  reasoning: string
  finishReason: string | null
  truncated: boolean
}
export interface ErrandTranscript {
  system: string
  errand: string
  turns: TranscriptTurn[]
  finalAnswer: string
}
export async function runAgentLoop (opts: {
  system: string, errand: string, tools: Record<string, (args: string) => Promise<string>>,
  toolDefs: ToolDef[], callModel: CallModel, maxCalls?: number, timeoutMs?: number,
  onTurn?: (turn: TranscriptTurn) => void,
}): Promise<{ finalAnswer: string, toolLog: ToolCallRecord[], truncatedTurns: number, transcript: ErrandTranscript }> {
  const maxCalls = opts.maxCalls ?? MAX_TOOL_CALLS
  const deadline = Date.now() + (opts.timeoutMs ?? ERRAND_TIMEOUT_MS)
  const messages: any[] = []
  const toolLog: ToolCallRecord[] = []
  const turns: TranscriptTurn[] = []
  const finish = (finalAnswer: string) => ({
    finalAnswer, toolLog, truncatedTurns, transcript: { system: opts.system, errand: opts.errand, turns, finalAnswer },
  })
  let calls = 0
  let truncatedTurns = 0
  for (;;) {
    if (Date.now() > deadline) return finish('(timed out)')
    if (calls >= maxCalls) return finish('(tool call limit reached)')
    const startedAt = Date.now()
    const res = await opts.callModel({ system: opts.system, errand: opts.errand, messages }, opts.toolDefs)
    const requestSeconds = (Date.now() - startedAt) / 1000
    const reasoning = String(res.reasoning ?? '').slice(0, TRANSCRIPT_OUTPUT_CHARS)
    const finishReason = res.finishReason ?? null
    messages.push({ role: 'assistant', content: res.content, toolCalls: res.toolCalls })
    // A length-cutoff with neither content nor a tool call is not an answer:
    // record it and ask once more; a second one ends the errand as now.
    if (finishReason === 'length' && !res.content && res.toolCalls.length === 0) {
      truncatedTurns++
      turns.push({ assistant: '', toolCalls: [], toolOutputs: [], requestSeconds, reasoning, finishReason, truncated: true })
      opts.onTurn?.(turns[turns.length - 1])
      if (truncatedTurns >= 2) return finish('')
      messages.push({ role: 'user', content: CUTOFF_RETRY })
      continue
    }
    if (!res.toolCalls.length) {
      turns.push({ assistant: res.content, toolCalls: [], toolOutputs: [], requestSeconds, reasoning, finishReason, truncated: false })
      opts.onTurn?.(turns[turns.length - 1])
      return finish(res.content)
    }
    const toolOutputs: string[] = []
    for (const tc of res.toolCalls) {
      calls++
      if (calls > maxCalls) break
      const fn = opts.tools[tc.name]
      const callStartedAt = Date.now()
      let out: string
      try { out = fn ? await fn(tc.args) : 'unknown tool: ' + tc.name }
      catch (e) { out = 'tool error: ' + String(e) }
      // tool fns log themselves into toolLog only for vortex/notes makers when
      // passed the same array; ensure a record exists:
      if (!toolLog.length || toolLog[toolLog.length - 1].at < callStartedAt || toolLog[toolLog.length - 1].args !== tc.args) {
        toolLog.push({ tool: tc.name, args: tc.args, output: out, at: Date.now() })
      }
      messages.push({ role: 'tool', name: tc.name, content: out })
      toolOutputs.push(out.slice(0, TRANSCRIPT_OUTPUT_CHARS))
      if (Date.now() > deadline || calls >= maxCalls) break
    }
    turns.push({
      assistant: res.content,
      toolCalls: res.toolCalls.map(t => ({ name: t.name, args: t.args })),
      toolOutputs,
      requestSeconds,
      reasoning,
      finishReason,
      truncated: false,
    })
    opts.onTurn?.(turns[turns.length - 1])
  }
}

// A past tool call in LFM2.5's own text form. The chat template in the LFM2.5
// GGUF files does not render an assistant message's `tool_calls`, so a call
// sent back the OpenAI way reaches the model as an empty turn and it repeats
// the call. Written into `content` instead, the model sees what it did.
export function lfmToolCallText (calls: { name: string, args: string }[], typed: (name: string) => boolean): string {
  const one = (t: { name: string, args: string }) => {
    let named: Record<string, unknown> = { args: t.args }
    if (typed(t.name)) { try { named = JSON.parse(t.args || '{}') } catch { named = {} } }
    return `${t.name}(${Object.entries(named).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')})`
  }
  return `<|tool_call_start|>[${calls.map(one).join(', ')}]<|tool_call_end|>`
}

// OpenAI-compatible chat completions call. requestTimeoutS bounds each HTTP
// request; slow CPU models need minutes, so the default is generous.
// maxTokens cuts a rambling model off instead of letting it run into the
// timeout; temperature keeps small models close to the errand.
export function makeOpenAICall (baseUrl: string, model: string, requestTimeoutS = DEFAULT_REQUEST_TIMEOUT_S,
  genOpts: { maxTokens?: number, temperature?: number, topK?: number, repeatPenalty?: number, lfmHistory?: boolean } = {}): CallModel {
  const maxTokens = genOpts.maxTokens ?? DEFAULT_MAX_TOKENS
  const temperature = genOpts.temperature ?? DEFAULT_TEMPERATURE
  const url = baseUrl.replace(/\/$/, '') + '/chat/completions'
  return async (req, tools) => {
    const typed = (name: string) => tools.find(t => t.name === name)?.parameters !== undefined
    const messages: any[] = [
      { role: 'system', content: req.system },
      { role: 'user', content: req.errand },
    ]
    for (const m of req.messages) {
      if (m.role === 'assistant' && m.toolCalls?.length && genOpts.lfmHistory) {
        messages.push({ role: 'assistant', content: (m.content || '') + lfmToolCallText(m.toolCalls, typed) })
      } else if (m.role === 'assistant' && m.toolCalls?.length) {
        messages.push({
          role: 'assistant', content: m.content || null,
          tool_calls: m.toolCalls.map((t: any, i: number) => ({
            id: `call_${req.messages.length}_${i}`, type: 'function',
            function: { name: t.name, arguments: typed(t.name) ? t.args : JSON.stringify({ args: t.args }) },
          })),
        })
      } else if (m.role === 'tool') {
        const last: any = messages[messages.length - 1]
        const id = last?.tool_calls?.[0]?.id ?? `call_${messages.length}_0`
        messages.push({ role: 'tool', tool_call_id: id, content: String(m.content) })
      } else messages.push({ role: m.role, content: String(m.content ?? '') })
    }
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
        ...(genOpts.topK !== undefined ? { top_k: genOpts.topK } : {}),
        ...(genOpts.repeatPenalty !== undefined ? { repeat_penalty: genOpts.repeatPenalty } : {}),
        tools: tools.map(t => ({
          type: 'function',
          function: t.parameters
            ? { name: t.name, description: t.description, parameters: { type: 'object', properties: Object.fromEntries(Object.entries(t.parameters).map(([k, d]) => [k, { type: 'string', description: d }])), required: Object.keys(t.parameters) } }
            : { name: t.name, description: `${t.description} Usage: ${t.usage}`, parameters: { type: 'object', properties: { args: { type: 'string' } }, required: ['args'] } },
        })),
        tool_choice: 'auto',
      }),
      signal: AbortSignal.timeout(requestTimeoutS * 1000),
      // Bun ends a fetch after 300 s without bytes; a slow CPU model sends none
      // until the whole reply is done, so only requestTimeoutS may end it.
      timeout: false,
    })
    if (!res.ok) throw new Error(`model HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
    const body: any = await res.json()
    const choice = body.choices?.[0]?.message
    if (!choice) throw new Error('empty model response')
    const toolCalls = (choice.tool_calls ?? []).map((c: any) => {
      const raw = c.function?.arguments ?? '{}'
      if (typed(c.function?.name ?? '')) return { name: c.function?.name ?? '', args: typeof raw === 'string' ? raw : JSON.stringify(raw) }
      let args = ''
      try { args = JSON.parse(raw).args ?? '' } catch { args = raw }
      return { name: c.function?.name ?? '', args: String(args) }
    })
    // A reply cut off by max_tokens with no tool call is still that turn's
    // content (the loop ends the errand with it), not an error. Reasoning
    // models put their thinking in reasoning_content; it counts against
    // max_tokens, is recorded in the transcript, and is never sent back.
    return {
      toolCalls,
      content: String(choice.content ?? ''),
      finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
      reasoning: typeof choice.reasoning_content === 'string' ? choice.reasoning_content : undefined,
    }
  }
}

// --- bob (scripted, no model) ---
export function randomCode (): string {
  return String(Math.floor(100000 + Math.random() * 900000))
}
export async function bobTick (bob: ServiceHandle, code: string, replied: { done: boolean, at: number }): Promise<{ repliedAt: number | null, replyCursor: number | null }> {
  let repliedAt: number | null = null
  let replyCursor: number | null = null
  const inbox: any = JSON.parse(await runCli(['inbox'], bob.dir))
  for (const [room, rec] of Object.entries<any>(inbox.rooms ?? {})) {
    if (rec.remoteConsent && !rec.localConsent) {
      try { await runCli(['accept', '--room', room], bob.dir) } catch { /* race; ignore */ }
    }
  }
  const read: any = JSON.parse(await runCli(['read', '--after', '0'], bob.dir))
  const firstMsg = (read.events ?? []).find((e: any) => e.kind === 'message' && typeof e.body === 'string')
  if (firstMsg && !replied.done) {
    const rooms: any = JSON.parse(await runCli(['inbox'], bob.dir))
    const rec = rooms.rooms?.[firstMsg.room]
    if (rec?.localConsent && rec?.remoteConsent) {
      // Stamp before sending: a waiting reader can log the reply before this call returns.
      const sendingAt = Date.now()
      await runCli(['send', '--room', firstMsg.room, '--text', `The code is ${code}`], bob.dir)
      replied.done = true
      replied.at = sendingAt
      repliedAt = replied.at
      const after: any = JSON.parse(await runCli(['read', '--after', '0'], bob.dir))
      replyCursor = after.cursor ?? null
    }
  }
  return { repliedAt, replyCursor }
}

// --- scoring (from service state, never model claims) ---
export interface VortexScores { dialed: boolean, invited: boolean, sent: boolean, read: boolean, acked: boolean, reported: boolean }
export function scoreVortex (opts: {
  alice: ServiceHandle, bob: ServiceHandle, toolLog: ToolCallRecord[],
  finalAnswer: string, code: string, replyAt: number | null,
}): VortexScores {
  const { alice, bob, toolLog, finalAnswer, code, replyAt } = opts
  const dialed = toolLog.some(t => t.tool === 'vortex' && /^\s*dial\b/.test(t.args) && /"peer"\s*:/.test(t.output) && !/"error"\s*:/.test(t.output))
  let invited = false
  let sent = false
  try {
    const bobState = readState(bob)
    invited = Object.values<any>(bobState.rooms ?? {}).some(r => r.remoteConsent === true)
    sent = (bobState.events ?? []).some((e: any) => e.kind === 'message' && typeof e.body === 'string' && e.body.includes(QUESTION))
  } catch { /* service gone; leave false */ }
  const read = replyAt !== null && toolLog.some(t => t.tool === 'vortex' && /^\s*(read|wait)\b/.test(t.args) && t.at >= replyAt && t.output.includes(code))
  let acked = false
  try {
    const aliceState = readState(alice)
    const replyCursor = Math.max(0, ...(aliceState.events ?? [])
      .filter((e: any) => e.kind === 'message' && typeof e.body === 'string' && e.body.includes(code))
      .map((e: any) => e.cursor))
    acked = replyCursor > 0 && (aliceState.acked ?? 0) >= replyCursor
  } catch { /* ignore */ }
  return { dialed, invited, sent, read, acked, reported: finalAnswer.includes(code) }
}

export interface ControlScores { added_first: boolean, added_second: boolean, listed: boolean, deleted: boolean, relisted: boolean, reported: boolean }
export const CONTROL_1 = { first: 'ember', second: 'tide' }
export const CONTROL_2 = { first: 'harbor', second: 'meadow' }
export function controlErrand (words: { first: string, second: string }): string {
  return `Add the note '${words.first}', add the note '${words.second}', list your notes, ` +
    `delete the note '${words.first}', list your notes again, and tell me the remaining note.`
}
export function scoreControl (toolLog: ToolCallRecord[], snapshots: { at: number, notes: string[] }[],
  finalAnswer: string, words: { first: string, second: string }): ControlScores {
  const saw = (re: RegExp) => toolLog.some(t => t.tool === 'notes' && re.test(t.args))
  const everHad = (w: string) => snapshots.some(s => s.notes.includes(w))
  const listIdx = toolLog.findIndex(t => t.tool === 'notes' && /^\s*list/.test(t.args))
  const delIdx = toolLog.findIndex(t => t.tool === 'notes' && /^\s*delete/.test(t.args))
  const lastListAfterDelete = delIdx >= 0 && toolLog.slice(delIdx + 1).some(t => t.tool === 'notes' && /^\s*list/.test(t.args))
  const last = snapshots[snapshots.length - 1]
  const deleted = delIdx >= 0 && everHad(words.first) && !!last && !last.notes.includes(words.first)
  return {
    added_first: everHad(words.first),
    added_second: everHad(words.second),
    listed: listIdx >= 0,
    deleted,
    relisted: lastListAfterDelete,
    reported: finalAnswer.includes(words.second) && !!last && last.notes.includes(words.second),
  }
}

// --- one full run (vortex errand + two controls) ---
export interface RunResult {
  run: number
  code: string
  vortex: VortexScores
  control1: ControlScores
  control2: ControlScores
  vortexCalls: number
  /** Wall seconds per errand. */
  seconds: { vortex: number, control1: number, control2: number }
  /** Length-truncated empty turns per errand (retried once, then errand ends). */
  truncatedTurns: { vortex: number, control1: number, control2: number }
  /** Present when a model/HTTP error (or setup failure) cut an errand short. */
  error?: string
}
const emptyVortex = (): VortexScores =>
  ({ dialed: false, invited: false, sent: false, read: false, acked: false, reported: false })
const emptyControl = (): ControlScores =>
  ({ added_first: false, added_second: false, listed: false, deleted: false, relisted: false, reported: false })
const noSeconds = () => ({ vortex: 0, control1: 0, control2: 0 })

/** Append one errand transcript file; no-op unless a transcript dir was given. */
function writeTranscript (dir: string | undefined, run: number, name: string,
  transcript: ErrandTranscript, scores: unknown, error: string | undefined): void {
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  const body = {
    run, name,
    system: transcript.system,
    errand: transcript.errand,
    turns: transcript.turns,
    finalAnswer: transcript.finalAnswer,
    scores,
    ...(error !== undefined ? { error } : {}),
  }
  writeFileSync(join(dir, `run-${run}-${name}.json`), JSON.stringify(body, null, 2))
}
export async function runOnce (run: number, callModel: CallModel, system: string,
  opts: { transcriptDir?: string, errandTimeoutMs?: number, typedTools?: boolean } = {}): Promise<RunResult> {
  const errandTimeoutMs = opts.errandTimeoutMs ?? ERRAND_TIMEOUT_MS
  const typedTools = opts.typedTools === true
  const started: ServiceHandle[] = []
  const errors: string[] = []
  const withError = (r: RunResult): RunResult => errors.length ? { ...r, error: errors.join('; ') } : r
  try {
    const alice = await startService('alice')
    started.push(alice)
    const bob = await startService('bob')
    started.push(bob)
    const code = randomCode()
    const bobAddr = dialableAddr(bob)
    const vortexErrand = `Connect to the peer at ${bobAddr}, invite it, send it the message '${QUESTION}', ` +
      `wait for its reply, acknowledge the reply, and tell me the code.`
    const vortexDefs: ToolDef[] = typedTools ? TYPED_VORTEX_DEFS : [{ name: 'vortex', description: 'Run a VORTEX CLI command for alice.', usage: 'dial --peer <addr> | invite --peer <id> | send --room <room> --text <text> | read | wait --timeout 60 | ack --cursor N | inbox | info' }]
    const vortexLog: ToolCallRecord[] = []
    const vortexTool = makeVortexTool(alice.dir, vortexLog)
    const replied = { done: false, at: 0 }
    let replyAt: number | null = null
    const stop = { stop: false }
    const bobLoop = (async () => {
      while (!stop.stop) {
        try {
          const r = await bobTick(bob, code, replied)
          if (r.repliedAt !== null && replyAt === null) replyAt = r.repliedAt
        } catch { /* transient; keep polling */ }
        await new Promise(res => setTimeout(res, 400))
      }
    })()
    let finalAnswer = ''
    let vortexError: string | undefined
    let vortexTruncated = 0
    const vortexTurns: TranscriptTurn[] = []
    const tVortex = Date.now()
    try {
      const r = await runAgentLoop({
        system, errand: vortexErrand,
        tools: typedTools ? makeTypedVortexTools(alice.dir, vortexLog) : { vortex: async (a: string) => await vortexTool(a) },
        toolDefs: vortexDefs, callModel, maxCalls: MAX_TOOL_CALLS, timeoutMs: errandTimeoutMs,
        onTurn: t => vortexTurns.push(t),
      })
      finalAnswer = r.finalAnswer
      vortexTruncated = r.truncatedTurns
    } catch (e) {
      // A model or HTTP error ends this errand only: score what was reached.
      vortexError = 'vortex: ' + errMsg(e)
      errors.push(vortexError)
    } finally { stop.stop = true; await bobLoop }
    const vortexSeconds = (Date.now() - tVortex) / 1000
    const vortex = scoreVortex({ alice, bob, toolLog: vortexLog, finalAnswer, code, replyAt })
    writeTranscript(opts.transcriptDir, run, 'vortex',
      { system, errand: vortexErrand, turns: vortexTurns, finalAnswer }, vortex, vortexError)

    const runControl = async (words: { first: string, second: string }, label: string) => {
      const log: ToolCallRecord[] = []
      const notes = makeNotesTool(log)
      const controlTurns: TranscriptTurn[] = []
      const errand = controlErrand(words)
      const notesSystem = typedTools ? TYPED_NOTES_SYSTEM : 'You have one tool: notes(args). Use it to manage a small note list.'
      let answer = ''
      let controlError: string | undefined
      let controlTruncated = 0
      const t0 = Date.now()
      try {
        const r = await runAgentLoop({
          system: notesSystem,
          errand,
          tools: typedTools ? makeTypedNotesTools(notes.fn) : { notes: notes.fn },
          toolDefs: typedTools ? TYPED_NOTES_DEFS : [{ name: 'notes', description: 'Manage an in-memory note list.', usage: 'add <text> | list | delete <text|index>' }],
          callModel, maxCalls: MAX_TOOL_CALLS, timeoutMs: errandTimeoutMs,
          onTurn: t => controlTurns.push(t),
        })
        answer = r.finalAnswer
        controlTruncated = r.truncatedTurns
      } catch (e) {
        controlError = `${label}: ` + errMsg(e)
        errors.push(controlError)
      }
      const seconds = (Date.now() - t0) / 1000
      const scores = scoreControl(log, notes.snapshots, answer, words)
      writeTranscript(opts.transcriptDir, run, label.toLowerCase(),
        { system: notesSystem, errand, turns: controlTurns, finalAnswer: answer }, scores, controlError)
      return { scores, seconds, truncatedTurns: controlTruncated }
    }
    const c1 = await runControl(CONTROL_1, 'control1')
    const c2 = await runControl(CONTROL_2, 'control2')
    return withError({
      run, code, vortex, control1: c1.scores, control2: c2.scores, vortexCalls: vortexLog.length,
      seconds: { vortex: vortexSeconds, control1: c1.seconds, control2: c2.seconds },
      truncatedTurns: { vortex: vortexTruncated, control1: c1.truncatedTurns, control2: c2.truncatedTurns },
    })
  } catch (e) {
    // Setup failure (a scratch service would not start): report, do not throw.
    errors.push('setup: ' + errMsg(e))
    return { run, code: '', vortex: emptyVortex(), control1: emptyControl(), control2: emptyControl(), vortexCalls: 0, seconds: noSeconds(), truncatedTurns: noSeconds(), error: errors.join('; ') }
  } finally {
    for (const h of started) await stopService(h).catch(() => {})
  }
}

// --- CLI ---
function parseCli (argv: string[]): { baseUrl: string, model: string, runs: number, requestTimeoutS: number, maxTokens: number, temperature: number, errandTimeoutS: number, transcriptDir: string | undefined, tools: string, topK: number | undefined, repeatPenalty: number | undefined, callHistory: string } {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const baseUrl = get('--base-url')
  const model = get('--model')
  const runs = Number(get('--runs') ?? '10')
  const requestTimeoutS = Number(get('--request-timeout-s') ?? String(DEFAULT_REQUEST_TIMEOUT_S))
  const maxTokens = Number(get('--max-tokens') ?? String(DEFAULT_MAX_TOKENS))
  const temperature = Number(get('--temperature') ?? String(DEFAULT_TEMPERATURE))
  const errandTimeoutS = Number(get('--errand-timeout-s') ?? String(DEFAULT_ERRAND_TIMEOUT_S))
  const transcriptDir = get('--transcript-dir')
  const tools = get('--tools') ?? 'string'
  const callHistory = get('--call-history') ?? 'openai'
  const topK = get('--top-k') === undefined ? undefined : Number(get('--top-k'))
  const repeatPenalty = get('--repeat-penalty') === undefined ? undefined : Number(get('--repeat-penalty'))
  if (!baseUrl || !model || !Number.isFinite(runs) || runs < 1 ||
      !Number.isFinite(requestTimeoutS) || requestTimeoutS <= 0 ||
      !Number.isFinite(maxTokens) || maxTokens < 1 ||
      !Number.isFinite(temperature) || temperature < 0 ||
      !Number.isFinite(errandTimeoutS) || errandTimeoutS <= 0 ||
      (tools !== 'string' && tools !== 'typed') ||
      (callHistory !== 'openai' && callHistory !== 'lfm') ||
      (topK !== undefined && !(topK >= 1)) || (repeatPenalty !== undefined && !(repeatPenalty > 0))) {
    console.error(`usage: bun bench/usability/run.ts --base-url <http://host:port/v1> --model <name> [--runs <n, default 10>] [--request-timeout-s <seconds, default ${DEFAULT_REQUEST_TIMEOUT_S}>] [--max-tokens <n, default ${DEFAULT_MAX_TOKENS}>] [--temperature <t, default ${DEFAULT_TEMPERATURE}>] [--errand-timeout-s <seconds, default ${DEFAULT_ERRAND_TIMEOUT_S}>] [--transcript-dir <dir>] [--tools <string|typed, default string>] [--top-k <n>] [--repeat-penalty <x>] [--call-history <openai|lfm, default openai>]`)
    process.exit(2)
  }
  return { baseUrl: baseUrl!, model: model!, runs, requestTimeoutS, maxTokens, temperature, errandTimeoutS, transcriptDir, tools, topK, repeatPenalty, callHistory }
}
export function summarize (results: RunResult[]): string {
  if (!results.length) return '(no runs)'
  const keys = (o: object) => Object.keys(o)
  const rows: { step: string, rate: string }[] = []
  const stepsV = results.length ? keys(results[0].vortex) : []
  const stepsC = results.length ? keys(results[0].control1) : []
  for (const s of stepsV) {
    const n = results.filter(r => (r.vortex as any)[s]).length
    rows.push({ step: `vortex.${s}`, rate: `${n}/${results.length} ${(100 * n / results.length).toFixed(1)}%` })
  }
  for (const [label, get] of [['control1', (r: RunResult) => r.control1], ['control2', (r: RunResult) => r.control2]] as const) {
    for (const s of stepsC) {
      const n = results.filter(r => (get(r) as any)[s]).length
      rows.push({ step: `${label}.${s}`, rate: `${n}/${results.length} ${(100 * n / results.length).toFixed(1)}%` })
    }
  }
  for (const [label, secs, trunc] of [
    ['vortex', (r: RunResult) => r.seconds.vortex, (r: RunResult) => r.truncatedTurns.vortex],
    ['control1', (r: RunResult) => r.seconds.control1, (r: RunResult) => r.truncatedTurns.control1],
    ['control2', (r: RunResult) => r.seconds.control2, (r: RunResult) => r.truncatedTurns.control2],
  ] as const) {
    const mean = results.reduce((a, r) => a + secs(r), 0) / results.length
    const truncated = results.reduce((a, r) => a + trunc(r), 0)
    rows.push({ step: `${label}.time`, rate: `mean ${mean.toFixed(1)}s, truncated ${truncated}` })
  }
  const w = Math.max(...rows.map(r => r.step.length))
  return ['step'.padEnd(w) + '  rate', ...rows.map(r => r.step.padEnd(w) + '  ' + r.rate)].join('\n')
}

if (import.meta.main) {
  const { baseUrl, model, runs, requestTimeoutS, maxTokens, temperature, errandTimeoutS, transcriptDir, tools, topK, repeatPenalty, callHistory } = parseCli(process.argv.slice(2))
  const typedTools = tools === 'typed'
  const system = typedTools ? TYPED_VORTEX_SYSTEM : buildSystemPrompt()
  const callModel = makeOpenAICall(baseUrl, model, requestTimeoutS, { maxTokens, temperature, topK, repeatPenalty, lfmHistory: callHistory === 'lfm' })
  process.stdout.write(JSON.stringify({ testing: model, baseUrl, runs, requestTimeoutS, maxTokens, temperature, errandTimeoutS, tools, topK, repeatPenalty, callHistory }) + '\n')
  const results: RunResult[] = []
  for (let i = 1; i <= runs; i++) {
    // runOnce never throws for model/HTTP errors (they land in `error`);
    // print each line as the run ends so a long session shows progress.
    const r = await runOnce(i, callModel, system, { transcriptDir, errandTimeoutMs: errandTimeoutS * 1000, typedTools })
    results.push(r)
    process.stdout.write(JSON.stringify({ run: r.run, model, vortex: r.vortex, control1: r.control1, control2: r.control2, vortexCalls: r.vortexCalls, seconds: r.seconds, truncatedTurns: r.truncatedTurns, ...(r.error !== undefined ? { error: r.error } : {}) }) + '\n')
  }
  console.log(summarize(results))
}
