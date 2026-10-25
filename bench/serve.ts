// Static server for the browser embedder benchmark: `bun bench/serve.ts`, then
// open the printed address. The cross-origin isolation headers let the WASM
// backend use threads; without them it runs single-threaded.
const root = new URL('..', import.meta.url).pathname
const port = Number(process.env.PORT ?? 8787)

Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch (req) {
    const path = decodeURIComponent(new URL(req.url).pathname)
    if (path.includes('..')) return new Response('bad path', { status: 400 })
    const file = Bun.file(root + (path === '/' ? 'bench/embed-browser.html' : path.slice(1)))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    return new Response(file, {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless'
      }
    })
  }
})
console.log(`http://127.0.0.1:${port}/`)
