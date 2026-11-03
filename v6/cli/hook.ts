// `vx hook context` (§8.6, §8.10): used by the Claude Code plugin hooks only.
// Reads the hook event JSON on stdin, asks the local MCP server (per-binding
// unix socket) for one bounded passive batch, prints hookSpecificOutput, and
// only after the full output is written and flushed tells the server to
// acknowledge `hook-returned`. Any failure before the write acknowledges nothing.
import { connect } from 'node:net'
import { bindingName, hookOrigin, socketPath, type HostName, type HookRequest, type HookResponse } from '../client/hooksocket.ts'

const EVENTS = new Set(['UserPromptSubmit', 'PostToolUse'])

function readStdin (): Promise<string> {
  return new Promise(resolve => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', c => { data += c })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(data))
  })
}

export async function hookContext (host: HostName = 'claude'): Promise<void> {
  let event: Record<string, unknown> = {}
  try { event = JSON.parse(await readStdin()) as Record<string, unknown> } catch { /* still record nothing */ }
  const eventName = event.hook_event_name
  const sock = connect(socketPath(bindingName(), host))
  const lines: HookResponse[] = []
  const waiters: Array<() => void> = []
  let buf = ''
  let dead = false
  sock.setEncoding('utf8')
  sock.on('data', (c: string) => {
    buf += c
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      try { lines.push(JSON.parse(buf.slice(0, i)) as HookResponse) } catch { /* ignore */ }
      buf = buf.slice(i + 1)
      waiters.splice(0).forEach(w => w())
    }
  })
  const end = (): void => { dead = true; waiters.splice(0).forEach(w => w()) }
  sock.on('close', end)
  sock.on('error', end)
  const next = async (ms: number): Promise<HookResponse | undefined> => {
    const deadline = Date.now() + ms
    while (lines.length === 0 && !dead) {
      const left = deadline - Date.now()
      if (left <= 0) return undefined
      await new Promise<void>(r => {
        const t = setTimeout(r, left)
        waiters.push(() => { clearTimeout(t); r() })
      })
    }
    return lines.shift()
  }
  const send = (r: HookRequest): void => { sock.write(JSON.stringify(r) + '\n') }

  await new Promise<void>(resolve => { sock.once('connect', resolve); sock.once('error', resolve) })
  if (dead) return // no local server: print nothing, exit 0
  send({ op: 'context', event, origin: hookOrigin() })
  const res = await next(5000)
  if (res === undefined || !res.ok || res.context === undefined || res.batch === undefined || typeof eventName !== 'string' || !EVENTS.has(eventName)) {
    sock.destroy()
    return // nothing pending (or a recorded human turn only): print nothing
  }
  const out = JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: res.context } }) + '\n'
  try {
    await new Promise<void>((resolve, reject) => process.stdout.write(out, err => (err ? reject(err) : resolve())))
  } catch {
    sock.destroy()
    return // write failed: acknowledge nothing
  }
  send({ op: 'ack', batch: res.batch })
  await next(2000)
  sock.destroy()
}
