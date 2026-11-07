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
import { freePort, readReady, startService, stopService, readState, dialableAddr, peerIdFromAddr, runCli, makeVortexTool, makeNotesTool, TYPED_VORTEX_SYSTEM, TYPED_NOTES_SYSTEM, TYPED_VORTEX_DEFS, TYPED_NOTES_DEFS, typedArgs, makeTypedVortexTools, makeTypedNotesTools, type ServiceHandle } from './run-tools.ts'
import { runAgentLoop, lfmToolCallText, makeOpenAICall, type TranscriptToolCall, type TranscriptTurn, type ErrandTranscript } from './run-loop.ts'
export { runAgentLoop, lfmToolCallText, makeOpenAICall } from './run-loop.ts'
export type { TranscriptToolCall, TranscriptTurn, ErrandTranscript } from './run-loop.ts'
export { freePort, readReady, startService, stopService, readState, dialableAddr, peerIdFromAddr, runCli, makeVortexTool, makeNotesTool, TYPED_VORTEX_SYSTEM, TYPED_NOTES_SYSTEM, TYPED_VORTEX_DEFS, TYPED_NOTES_DEFS, makeTypedVortexTools, makeTypedNotesTools } from './run-tools.ts'
export type { ServiceHandle } from './run-tools.ts'

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
