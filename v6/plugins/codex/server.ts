#!/usr/bin/env bun
// VORTEX v6 Codex plugin: stdio MCP server (docs/v6-proposal.md §8.7, §8.9).
// Exactly one model tool: vx_send. Wakes go to the bound chat through the
// app-server (bridge.ts); there is no channel capability.
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { loadCredential, type Credential } from '../../client/credential.ts'
import { bindingName } from '../../client/hooksocket.ts'
import { INSTRUCTIONS, TOOL, parseSendArgs, readStdio, stdoutWriter } from '../../client/mcp.ts'
import { CodexBridge } from './bridge.ts'
import { StdioAppServer } from './appserver.ts'

export { TOOL, parseSendArgs }

function resolveCredential (): Credential {
  const file = process.env.VORTEX_CREDENTIAL_FILE
  if (file !== undefined) return JSON.parse(readFileSync(file, 'utf8')) as Credential
  const c = loadCredential('codex')
  if (c === undefined) throw new Error(`no credential at ${process.env.XDG_CONFIG_HOME ?? `${homedir()}/.config`}/vortex/codex.json; run: vx enroll codex`)
  return c
}

function stateBase (binding: string): string {
  const base = process.env.XDG_STATE_HOME ?? `${homedir()}/.local/state`
  return `${base.replace(/\/$/, '')}/vortex/codex-${binding.replace(/[^A-Za-z0-9_.-]/g, '_')}`
}

async function main (): Promise<void> {
  const binding = bindingName()
  const credential = resolveCredential()
  const write = stdoutWriter()
  const bridge = new CodexBridge({
    credential,
    binding,
    rooms: Array.isArray(credential.rooms) ? credential.rooms as string[] : ['all'],
    stateFile: `${stateBase(binding)}.batches.json`,
    turnsFile: `${stateBase(binding)}.turns.json`,
    appServer: new StdioAppServer(),
    pullWaitMs: process.env.VORTEX_PULL_WAIT_MS === undefined ? undefined : Number(process.env.VORTEX_PULL_WAIT_MS),
  })

  const reply = (id: unknown, result: unknown): Promise<void> => write({ jsonrpc: '2.0', id, result })
  const fail = (id: unknown, code: number, message: string): Promise<void> => write({ jsonrpc: '2.0', id, error: { code, message } })

  async function handle (msg: any): Promise<void> {
    const { id, method, params } = msg
    if (method === 'initialize') {
      await reply(id, {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'vortex', version: '6.0.0' },
        instructions: INSTRUCTIONS,
      })
    } else if (method === 'notifications/initialized') {
      // nothing: Codex wakes do not depend on MCP session state
    } else if (method === 'ping') {
      await reply(id, {})
    } else if (method === 'tools/list') {
      await reply(id, { tools: [TOOL] })
    } else if (method === 'tools/call') {
      if (params?.name !== TOOL.name) { await fail(id, -32602, `unknown tool: ${params?.name}`); return }
      try {
        const out = await bridge.send(parseSendArgs(params.arguments))
        const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: JSON.stringify(out) }]
        const st = bridge.status()
        if (st !== 'ok') content.push({ type: 'text', text: `warning: ${st}` })
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
