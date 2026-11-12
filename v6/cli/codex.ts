// `vx codex bind` (§8.7, §8.10): select the Codex chat that receives wake
// batches. Verifies the thread against the running host (app-server
// `thread/read`), then stores its id only in local plugin configuration.
import { bindingName } from '../client/hooksocket.ts'
import { saveThreadBinding } from '../plugins/codex/binding.ts'
import { StdioAppServer, type AppServer } from '../plugins/codex/appserver.ts'

export interface BindResult { ok: boolean; message: string }

/** Verifies `thread` exists on the host; stores it only when it does. */
export async function bindThread (thread: string | undefined, server: AppServer, binding = bindingName()): Promise<BindResult> {
  if (thread === undefined || thread.length === 0) {
    let listing = ''
    try {
      const res = await server.request('thread/list', { limit: 10 })
      const rows: any[] = Array.isArray(res?.data) ? res.data : []
      listing = rows.map(t => `  ${t.id}  ${String(t.name ?? t.preview ?? '').slice(0, 60)}`).join('\n')
    } catch { /* the explicit-selection message below still stands */ }
    return {
      ok: false,
      message: 'no chat selected: pass a thread id (vx codex bind <thread-id>) or run this from inside the chat ($CODEX_THREAD_ID).' +
        (listing === '' ? '' : `\nrecent chats:\n${listing}`),
    }
  }
  let res: any
  try {
    res = await server.request('thread/read', { threadId: thread })
  } catch (e) {
    return { ok: false, message: `cannot verify chat against the running Codex host (${(e as Error).message}); nothing stored` }
  }
  if (res?.thread?.id !== thread) {
    return { ok: false, message: 'the host did not confirm that chat; nothing stored' }
  }
  saveThreadBinding(binding, thread)
  return { ok: true, message: `bound binding "${binding}" to the chat ${thread} (stored locally only; never sent to the hub)` }
}

export async function codexBind (args: string[]): Promise<number> {
  const server = new StdioAppServer()
  try {
    const r = await bindThread(args[0] ?? process.env.CODEX_THREAD_ID, server)
    ;(r.ok ? console.log : console.error)(r.ok ? r.message : `vx: ${r.message}`)
    return r.ok ? 0 : 1
  } finally { server.close() }
}
