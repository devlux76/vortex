#!/usr/bin/env bun
// VORTEX v6 Claude Code plugin: stdio MCP server + channel (docs/v6-proposal.md §8.6, §8.9).
// A minimal newline-delimited JSON-RPC MCP server (no SDK dependency): initialize, ping,
// tools/list, tools/call. Exactly one model tool: vx_send.
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import type { Credential } from '../../client/credential.ts'
import { loadCredential } from '../../client/credential.ts'
import { Bridge, INSTRUCTIONS, type SendArgs } from './bridge.ts'
import { bindingName } from './socket.ts'

export const TOOL = {
  name: 'vx_send',
  description: 'Send a message to other agents through VORTEX. Room post by default; scope "dm" for a private message to one recipient.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Message text.' },
      to: { type: 'array', items: { type: 'string' }, description: 'Principals who should answer (room) or the one DM recipient.' },
      room: { type: 'string', description: 'Room name; defaults to "all".' },
      scope: { type: 'string', enum: ['room', 'dm'] },
    },
    required: ['text'],
    additionalProperties: false,
  },
} as const

const ALLOWED = new Set(['text', 'to', 'room', 'scope'])

/** Validates model-supplied arguments: only text/to/room/scope exist (no identity, no human_turn). */
export function parseSendArgs (raw: unknown): SendArgs {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('arguments must be an object')
  const a = raw as Record<string, unknown>
  for (const k of Object.keys(a)) if (!ALLOWED.has(k)) throw new Error(`unknown argument: ${k}`)
  if (typeof a.text !== 'string' || a.text.length === 0) throw new Error('text must be a non-empty string')
  if (a.to !== undefined && (!Array.isArray(a.to) || a.to.some(t => typeof t !== 'string'))) throw new Error('to must be an array of strings')
  if (a.room !== undefined && typeof a.room !== 'string') throw new Error('room must be a string')
  if (a.scope !== undefined && a.scope !== 'room' && a.scope !== 'dm') throw new Error('scope must be "room" or "dm"')
  return { text: a.text, to: a.to as string[] | undefined, room: a.room as string | undefined, scope: a.scope as 'room' | 'dm' | undefined }
}

function resolveCredential (): Credential {
  const file = process.env.VORTEX_CREDENTIAL_FILE
  if (file !== undefined) return JSON.parse(readFileSync(file, 'utf8')) as Credential
  const c = loadCredential('claude') // $XDG_CONFIG_HOME/vortex/claude.json, else ~/.config/vortex/claude.json
  if (c === undefined) throw new Error(`no credential at ${process.env.XDG_CONFIG_HOME ?? `${homedir()}/.config`}/vortex/claude.json; run: vx enroll claude`)
  return c
}

function stateFile (binding: string): string {
  const base = process.env.XDG_STATE_HOME ?? `${homedir()}/.local/state`
  return `${base.replace(/\/$/, '')}/vortex/claude-${binding.replace(/[^A-Za-z0-9_.-]/g, '_')}.batches.json`
}

async function main (): Promise<void> {
  const binding = bindingName()
  const credential = resolveCredential()
  const write = (obj: unknown): Promise<void> => new Promise((resolve, reject) => {
    process.stdout.write(JSON.stringify(obj) + '\n', err => (err ? reject(err) : resolve()))
  })
  const bridge = new Bridge({
    credential,
    binding,
    rooms: Array.isArray(credential.rooms) ? credential.rooms as string[] : ['all'],
    stateFile: stateFile(binding),
    pullWaitMs: process.env.VORTEX_PULL_WAIT_MS === undefined ? undefined : Number(process.env.VORTEX_PULL_WAIT_MS),
    notify: params => write({ jsonrpc: '2.0', method: 'notifications/claude/channel', params }),
  })

  const reply = (id: unknown, result: unknown): Promise<void> => write({ jsonrpc: '2.0', id, result })
  const fail = (id: unknown, code: number, message: string): Promise<void> => write({ jsonrpc: '2.0', id, error: { code, message } })

  async function handle (msg: any): Promise<void> {
    const { id, method, params } = msg
    if (method === 'initialize') {
      await reply(id, {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
        serverInfo: { name: 'vortex', version: '6.0.0' },
        instructions: INSTRUCTIONS,
      })
    } else if (method === 'notifications/initialized') {
      await bridge.markInitialized()
    } else if (method === 'ping') {
      await reply(id, {})
    } else if (method === 'tools/list') {
      await reply(id, { tools: [TOOL] })
    } else if (method === 'tools/call') {
      if (params?.name !== TOOL.name) { await fail(id, -32602, `unknown tool: ${params?.name}`); return }
      try {
        const out = await bridge.send(parseSendArgs(params.arguments))
        const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: JSON.stringify(out) }]
        if (!bridge.initialized) content.push({ type: 'text', text: 'warning: channels not enabled' })
        await reply(id, { content, structuredContent: out })
      } catch (e) {
        await reply(id, { content: [{ type: 'text', text: (e as Error).message }], isError: true })
      }
    } else if (id !== undefined) {
      await fail(id, -32601, `method not found: ${method}`)
    }
  }

  await bridge.start()
  let buf = ''
  const decoder = new TextDecoder()
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (line.length === 0) continue
      let msg: unknown
      try { msg = JSON.parse(line) } catch { continue }
      void handle(msg).catch(() => {})
    }
  }
  bridge.stop()
  process.exit(0)
}

if (import.meta.main) void main()
