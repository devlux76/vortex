import { DEFAULT_REQUEST_TIMEOUT_S, DEFAULT_MAX_TOKENS, DEFAULT_TEMPERATURE } from './run.ts'
import type { ToolDef, CallModel, ToolCallRecord } from './run.ts'
import { MAX_TOOL_CALLS, ERRAND_TIMEOUT_MS, TRANSCRIPT_OUTPUT_CHARS, CUTOFF_RETRY } from './run.ts'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { freePort, readReady, startService, stopService, readState, dialableAddr, peerIdFromAddr, runCli, makeVortexTool, makeNotesTool, TYPED_VORTEX_SYSTEM, TYPED_NOTES_SYSTEM, TYPED_VORTEX_DEFS, TYPED_NOTES_DEFS, typedArgs, makeTypedVortexTools, makeTypedNotesTools, type ServiceHandle } from './run-tools.ts'

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
