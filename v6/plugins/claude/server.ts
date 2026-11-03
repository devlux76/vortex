#!/usr/bin/env bun
// VORTEX v6 Claude Code plugin: stdio MCP server + channel (docs/v6-proposal.md §8.6, §8.9).
// A minimal newline-delimited JSON-RPC MCP server (no SDK dependency): initialize, ping,
// tools/list, tools/call. Model tools: vx_send and the read-only vx_read (A5).
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import type { Credential } from '../../client/credential.ts'
import { loadCredential } from '../../client/credential.ts'
import { Bridge } from './bridge.ts'
import { bindingName } from '../../client/hooksocket.ts'
import { INSTRUCTIONS, TOOL, parseSendArgs, readStdio, stdoutWriter } from '../../client/mcp.ts'
import { READ_TOOL, parseReadArgs, readHistory } from '../../client/read.ts'

export { TOOL, parseSendArgs }

function resolveCredential (): Credential {
  const file = process.env.VORTEX_CREDENTIAL_FILE
  if (file !== undefined) return JSON.parse(readFileSync(file, 'utf8')) as Credential
  const c = loadCredential('claude') // $XDG_CONFIG_HOME/vortex/claude.json, else ~/.config/vortex/claude.json
  if (c === undefined) throw new Error(`no credential at ${process.env.XDG_CONFIG_HOME ?? `${homedir()}/.config`}/vortex/claude.json; on the hub host run: vx enroll claude, then save the printed token in that file as {\"hub\": \"ws://127.0.0.1:7900\", \"token\": \"<token>\"} (mode 0600)`)
  return c
}

function stateFile (binding: string): string {
  const base = process.env.XDG_STATE_HOME ?? `${homedir()}/.local/state`
  return `${base.replace(/\/$/, '')}/vortex/claude-${binding.replace(/[^A-Za-z0-9_.-]/g, '_')}.batches.json`
}

async function main (): Promise<void> {
  const binding = bindingName()
  const credential = resolveCredential()
  const write = stdoutWriter()
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
      await reply(id, { tools: [TOOL, READ_TOOL] })
    } else if (method === 'tools/call') {
      if (params?.name === READ_TOOL.name) {
        // A5: read-only, non-consuming history (works with or without wake/channels).
        try {
          await reply(id, { content: [{ type: 'text', text: await readHistory(bridge.client, parseReadArgs(params.arguments)) }] })
        } catch (e) {
          await reply(id, { content: [{ type: 'text', text: (e as Error).message }], isError: true })
        }
        return
      }
      if (params?.name !== TOOL.name) { await fail(id, -32602, `unknown tool: ${params?.name}`); return }
      try {
        const out = await bridge.send(parseSendArgs(params.arguments))
        const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: JSON.stringify(out) }]
        if (!bridge.initialized) content.push({ type: 'text', text: 'warning: MCP session not initialized yet; wakes are held' })
        await reply(id, { content, structuredContent: out })
      } catch (e) {
        await reply(id, { content: [{ type: 'text', text: (e as Error).message }], isError: true })
      }
    } else if (id !== undefined) {
      await fail(id, -32601, `method not found: ${method}`)
    }
  }

  await bridge.start()
  await readStdio(handle)
  bridge.stop()
  process.exit(0)
}

if (import.meta.main) void main()
