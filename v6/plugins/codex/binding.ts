// The selected Codex chat (§6, §8.7): the thread id lives only in this local
// plugin file. It is never sent to the hub, a peer, or a model.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { vortexConfigDir } from '../../client/credential.ts'

export interface ThreadBinding { thread: string; binding: string; boundAt: number }

export function bindingFile (binding: string): string {
  return `${vortexConfigDir()}/codex-thread-${binding.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`
}

/** Returns the bound thread for this VORTEX binding, or undefined when missing or malformed. */
export function loadThreadBinding (binding: string): ThreadBinding | undefined {
  const path = bindingFile(binding)
  if (!existsSync(path)) return undefined
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as ThreadBinding
    if (typeof v.thread !== 'string' || v.thread.length === 0 || v.binding !== binding) return undefined
    return v
  } catch { return undefined }
}

export function saveThreadBinding (binding: string, thread: string): void {
  mkdirSync(vortexConfigDir(), { recursive: true, mode: 0o700 })
  const path = bindingFile(binding)
  writeFileSync(path, JSON.stringify({ thread, binding, boundAt: Date.now() } satisfies ThreadBinding, null, 2) + '\n', { mode: 0o600 })
  chmodSync(path, 0o600)
}
