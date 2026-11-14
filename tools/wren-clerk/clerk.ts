#!/usr/bin/env bun
// Wren clerk pilot. One task, one issue per run; there is no loop.
// Fetching is plain code. The model only reads the squashed thread and answers in raw-text tags.
// Usage: bun tools/wren-clerk/clerk.ts <task> <issue#> [--post]
// Environment: WREN_ENDPOINT (OpenAI-compatible chat-completions URL), WREN_MODEL (model id).
// The model name and endpoint are read from the environment and never written into the source.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = 'devlux76/vortex'
// No truncation: the router serves the model's full native context. Override only for experiments.
const MAX_PROMPT_CHARS = Number(process.env.WREN_MAX_PROMPT_CHARS ?? Infinity)

export interface Comment { user: string; created_at: string; body: string }
export interface Parsed {
  comments: { issue: number; body: string }[]
  noops: string[]
  answers: string[]
}

/** Alias = the bold signature at the start of the body; fall back to `operator`. */
export function aliasOf(body: string): string {
  const m = /^\s*\*\*([^*\n]+?)\*\*/.exec(body)
  return m ? m[1].trim() : 'operator'
}

function block(c: Comment): string {
  return `[${aliasOf(c.body)}] [${c.created_at}]\n${c.body.trim()}\n`
}

/** Squash a thread to `[alias] [created_at]` followed by the body, oldest first. */
export function squash(comments: Comment[]): string {
  return comments.map(block).join('\n')
}

/** Build the prompt. If it exceeds the budget, keep the issue body and the newest comments that fit. */
export function buildPrompt(system: string, issueBody: string, comments: Comment[], instruction: string, maxChars = MAX_PROMPT_CHARS) {
  const head = `Issue body:\n${issueBody.trim()}\n\nThread:\n`
  const tail = `\n\nInstruction:\n${instruction}`
  const budget = Math.max(0, maxChars - system.length - head.length - tail.length)
  const blocks = comments.map(block)
  const kept: string[] = []
  let used = 0
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (used + blocks[i].length + 1 > budget) break
    used += blocks[i].length + 1
    kept.unshift(blocks[i])
  }
  const user = head + kept.join('\n') + tail
  return { user, chars: system.length + user.length, kept: kept.length, dropped: blocks.length - kept.length }
}

/** Parse raw-text tags only. Never JSON. */
export function parseTags(text: string): Parsed {
  return {
    comments: [...text.matchAll(/<comment issue="(\d+)">([\s\S]*?)<\/comment>/g)]
      .map(m => ({ issue: Number(m[1]), body: m[2].trim() })),
    noops: [...text.matchAll(/<noop reason="([^"]*)"\s*\/>/g)].map(m => m[1]),
    answers: [...text.matchAll(/<answer>([\s\S]*?)<\/answer>/g)].map(m => m[1].trim()),
  }
}

/** Refuse to post anything whose body does not begin **Wren**. */
export function assertPostable(body: string): void {
  if (!body.startsWith('**Wren**')) throw new Error('refusing to post: body must begin **Wren**')
}

async function run(cmd: string[], stdin?: Blob): Promise<string> {
  const p = Bun.spawn(cmd, { stdin: stdin ?? 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  if ((await p.exited) !== 0) throw new Error(`${cmd.slice(0, 3).join(' ')} failed: ${err.trim()}`)
  return out
}

async function fetchIssue(n: number) {
  const body = await run(['gh', 'api', `repos/${REPO}/issues/${n}`, '--jq', '.body'])
  const lines = (await run(['gh', 'api', `repos/${REPO}/issues/${n}/comments`, '--paginate', '--jq', '.[] | @json']))
    .split('\n').filter(Boolean)
  const comments: Comment[] = lines.map(l => {
    const o = JSON.parse(l)
    return { user: o.user.login, created_at: o.created_at, body: o.body ?? '' }
  })
  return { body, comments }
}

async function callModel(system: string, user: string) {
  const endpoint = process.env.WREN_ENDPOINT
  const model = process.env.WREN_MODEL
  if (!endpoint || !model) throw new Error('set WREN_ENDPOINT and WREN_MODEL')
  const t0 = performance.now()
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model, temperature: 0.1, // no max_tokens: let it think and answer in full
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
    // CPU run: no client timeout (Bun-specific option).
    timeout: false,
  } as RequestInit)
  if (!res.ok) throw new Error(`model request failed: HTTP ${res.status}`)
  const json = await res.json() as { choices: { message: { content: string; reasoning_content?: string } }[]; usage?: unknown }
  const msg = json.choices[0].message
  const raw = msg.content ?? ''
  const inline = [...raw.matchAll(/<think>([\s\S]*?)<\/think>/g)].map(m => m[1])
  const thinking = [msg.reasoning_content ?? '', ...inline].filter(Boolean).join('\n')
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  return { text, thinking, usage: json.usage, wallMs: Math.round(performance.now() - t0) }
}

async function main(argv: string[]) {
  const [task, issueArg, ...flags] = argv
  if (!task || !issueArg) throw new Error('usage: clerk.ts <task> <issue#> [--post]')
  const issue = Number(issueArg)
  const promptPath = join(HERE, 'prompts', `${task}.md`)
  if (!existsSync(promptPath)) throw new Error(`no prompt for task: ${task}`)
  const system = readFileSync(promptPath, 'utf8')

  const { body, comments } = await fetchIssue(issue)
  const prompt = buildPrompt(system, body, comments, `Run task "${task}" on issue #${issue}. Answer now, using only the tags.`)
  console.error(`prompt: ${prompt.chars} chars, kept ${prompt.kept} of ${prompt.kept + prompt.dropped} comments`)

  const reply = await callModel(system, prompt.user)
  console.error(`model: ${reply.wallMs} ms, usage ${JSON.stringify(reply.usage)}`)

  const parsed = parseTags(reply.text)
  const outDir = join(HERE, 'out')
  mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outFile = join(outDir, `${task}-${issue}-${stamp}.md`)
  writeFileSync(outFile, [
    `# ${task} #${issue}`, '',
    `- prompt chars: ${prompt.chars}`, `- comments kept: ${prompt.kept} of ${prompt.kept + prompt.dropped}`,
    `- wall ms: ${reply.wallMs}`, `- usage: ${JSON.stringify(reply.usage)}`, '',
    '## Raw output', '', reply.text, '',
    '## Thinking', '', `(${reply.thinking.length} chars)`, '', reply.thinking, '',
    '## Parsed', '', '```json', JSON.stringify(parsed, null, 2), '```', '',
  ].join('\n'))
  console.error(`wrote ${outFile}`)

  if (flags.includes('--post')) {
    for (const c of parsed.comments) {
      assertPostable(c.body)
      await run(['gh', 'issue', 'comment', String(c.issue), '--body-file', '-'], new Blob([c.body]))
      console.error(`posted to #${c.issue}`)
    }
  } else if (parsed.comments.length) {
    console.error(`dry run: ${parsed.comments.length} comment(s) not posted`)
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
}
