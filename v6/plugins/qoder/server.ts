#!/usr/bin/env bun
// VORTEX v6 Qoder connector: stdio MCP server, tools only (A5 baseline).
// Qoder has no verified wake or hook path, so this plugin opens no binding
// stream: mail waits at the hub and the model pulls it with vx_read, which
// never marks anything delivered.
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { loadCredential, type Credential } from '../../client/credential.ts'
import { VortexClient } from '../../client/client.ts'
import { INSTRUCTIONS, TOOL, parseSendArgs, readStdio, stdoutWriter } from '../../client/mcp.ts'
import { READ_TOOL, parseReadArgs, readHistory } from '../../client/read.ts'
import { negotiateProtocol } from '../../client/mcp-version.ts'

function resolveCredential (): Credential {
  const file = process.env.VORTEX_CREDENTIAL_FILE
  if (file !== undefined) return JSON.parse(readFileSync(file, 'utf8')) as Credential
  const c = loadCredential('qoder')
  if (c === undefined) throw new Error(`no credential at ${process.env.XDG_CONFIG_HOME ?? `${homedir()}/.config`}/vortex/qoder.json; on the hub host run: vx install qoder`)
  return c
}

async function main (): Promise<void> {
  const client = new VortexClient(resolveCredential())
  const write = stdoutWriter()

  const reply = (id: unknown, result: unknown): Promise<void> => write({ jsonrpc: '2.0', id, result })
  const fail = (id: unknown, code: number, message: string): Promise<void> => write({ jsonrpc: '2.0', id, error: { code, message } })

  async function handle (msg: any): Promise<void> {
    const { id, method, params } = msg
    if (method === 'initialize') {
      await reply(id, {
        protocolVersion: negotiateProtocol(params?.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: { name: 'vortex', version: '6.0.0' },
        instructions: INSTRUCTIONS,
      })
    } else if (method === 'notifications/initialized') {
      // tools-only: no session state, no stream to arm
    } else if (method === 'ping') {
      await reply(id, {})
    } else if (method === 'tools/list') {
      await reply(id, { tools: [TOOL, READ_TOOL] })
    } else if (method === 'tools/call') {
      if (params?.name === READ_TOOL.name) {
        try {
          await reply(id, { content: [{ type: 'text', text: await readHistory(client, parseReadArgs(params.arguments)) }] })
        } catch (e) {
          await reply(id, { content: [{ type: 'text', text: (e as Error).message }], isError: true })
        }
        return
      }
      if (params?.name !== TOOL.name) { await fail(id, -32602, `unknown tool: ${params?.name}`); return }
      try {
        const args = parseSendArgs(params.arguments)
        if (args.scope === 'dm' && (args.room !== undefined || args.to?.length !== 1)) {
          throw new Error('a DM needs scope "dm", exactly one recipient in `to`, and no room')
        }
        const res = await client.send({
          text: args.text,
          ...(args.scope === undefined ? {} : { scope: args.scope }),
          ...(args.room === undefined ? {} : { room: args.room }),
          ...(args.to === undefined || args.to.length === 0 ? {} : { to: args.to }),
        })
        const out = { id: res.id }
        await reply(id, { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out })
      } catch (e) {
        await reply(id, { content: [{ type: 'text', text: (e as Error).message }], isError: true })
      }
    } else if (id !== undefined) {
      await fail(id, -32601, `method not found: ${method}`)
    }
  }

  await readStdio(handle)
  process.exit(0)
}

if (import.meta.main) void main()