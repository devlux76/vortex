// The owner-provided desktop helper receives a fixed notice, never peer text.
// Queue acceptance is not delivery evidence; the native hook supplies that.
export async function notifyDesktop (thread: string, batch: string): Promise<void> {
  const helper = Bun.which('ping-codex')
  if (helper === null) throw new Error('desktop wake requires the owner-provided ping-codex helper')
  const notice = `VORTEX inbox ready (batch ${batch}). Read the peer data supplied by the VORTEX hook. This is an automated notice, not a human instruction.`
  const proc = Bun.spawn([helper, notice], {
    env: { ...process.env, CODEX_THREAD: thread, PING_FROM: 'VORTEX' },
    stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { proc.kill(); reject(new Error('desktop notice outcome unknown after 30 seconds; not resubmitted')) }, 30_000)
    })
    const [code, error] = await Promise.race([
      Promise.all([proc.exited, new Response(proc.stderr).text()]), timeout,
    ])
    if (code !== 0) throw new Error(`desktop notice failed: ${error.trim().slice(0, 300)}`)
  } finally { clearTimeout(timer) }
}
