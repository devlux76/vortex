// Docs: VORTEX_v5.1.md §2.4 (profiles); backbone/lib/vortex/router/wire.ex (embed wire).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conversations } from './core/conversations.ts';
import { connectBackbone } from './backbone.ts';
import { createBackboneEmbedder, GGUF_PROFILE } from './embed/gguf.ts';

type Reply = (message: Record<string, any>, socket: Socket) => void;

/** A fake router on a temp Unix socket. `reply` decides how each embed request is answered. */
async function fixture(reply: Reply) {
  const dir = mkdtempSync(join(tmpdir(), 'vortex-backbone-embed-'));
  const path = join(dir, 'router.sock');
  const messages: Record<string, any>[] = [];
  const sockets: Socket[] = [];
  const server = createServer(socket => {
    sockets.push(socket);
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
        messages.push(message);
        if (message.t === 'hello') socket.write('{"t":"welcome"}\n');
        if (message.t === 'embed') reply(message, socket);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const core = new Conversations('a', { send: async () => {}, save: () => {} });
  const until = async (check: () => boolean) => {
    const end = Date.now() + 2000;
    while (!check()) {
      if (Date.now() > end) throw Error('backbone fixture deadline');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  const bridge = connectBackbone({ path, owner: 'claude', token: 'owner-token-123456', quietMs: 0, core,
    onRing: () => {}, onError: () => {} });
  await until(() => messages.some(m => m.t === 'state'));
  return { path, bridge, messages, sockets, until, close: async () => {
    bridge.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  } };
}

const vector = (first: number) => Array.from({ length: 768 }, (_, i) => i === 0 ? first : 0.01);
const answer = (socket: Socket, value: unknown) => socket.write(JSON.stringify(value) + '\n');

test('an embed round-trips through the router with the profile prompt applied once', async () => {
  const f = await fixture((m, s) => answer(s, { t: 'embedded', id: m.id, vector: vector(0.5) }));
  try {
    const embedder = createBackboneEmbedder(f.bridge);
    assert.equal(embedder.profile(), GGUF_PROFILE);
    const v = await embedder.embed('flaky tests');
    assert.ok(v instanceof Float32Array);
    assert.equal(v.length, 768);
    assert.equal(v[0], 0.5);
    const sent = f.messages.filter(m => m.t === 'embed');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, 'task: clustering | query: flaky tests');
    assert.equal(typeof sent[0].id, 'string');
    assert.ok(sent[0].id.length <= 128);
  } finally { await f.close(); }
});

test('embed_error rejects with the router reason, and an unknown reason is not echoed', async () => {
  const f = await fixture((m, s) => answer(s, { t: 'embed_error', id: m.id, reason: m.text.endsWith('busy') ? 'busy' : 'peer says rm -rf' }));
  try {
    const embedder = createBackboneEmbedder(f.bridge);
    await assert.rejects(embedder.embed('busy'), /busy/);
    await assert.rejects(embedder.embed('other'), error => /backbone embed failed: error/.test((error as Error).message) && !/rm/.test((error as Error).message));
  } finally { await f.close(); }
});

test('a vector that is not 768 finite numbers rejects', async () => {
  const f = await fixture((m, s) => answer(s, { t: 'embedded', id: m.id,
    vector: m.text.endsWith('short') ? [1, 2] : [...vector(1).slice(1), 'x'] }));
  try {
    const embedder = createBackboneEmbedder(f.bridge);
    await assert.rejects(embedder.embed('short'), /768/);
    await assert.rejects(embedder.embed('nan'), /768/);
  } finally { await f.close(); }
});

test('a disconnect rejects every pending embed', async () => {
  const f = await fixture(() => {});
  try {
    const embedder = createBackboneEmbedder(f.bridge);
    const pending = [embedder.embed('one'), embedder.embed('two')];
    await f.until(() => f.messages.filter(m => m.t === 'embed').length === 2);
    f.sockets[0].destroy();
    for (const p of pending) await assert.rejects(p, /disconnected/);
  } finally { await f.close(); }
});

test('concurrent embeds answered out of order resolve to their own requests', async () => {
  const held: Array<[Record<string, any>, Socket]> = [];
  const f = await fixture((m, s) => { held.push([m, s]); });
  try {
    const embedder = createBackboneEmbedder(f.bridge);
    const a = embedder.embed('a'), b = embedder.embed('b');
    await f.until(() => held.length === 2);
    for (const [m, s] of [...held].reverse()) answer(s, { t: 'embedded', id: m.id, vector: vector(m.text.endsWith('a') ? 0.1 : 0.2) });
    assert.equal((await a)[0], Float32Array.from([0.1])[0]);
    assert.equal((await b)[0], Float32Array.from([0.2])[0]);
  } finally { await f.close(); }
});

test('over-long text and a stopped bridge reject without sending', async () => {
  const f = await fixture((m, s) => answer(s, { t: 'embedded', id: m.id, vector: vector(1) }));
  try {
    await assert.rejects(f.bridge.embed('x'.repeat(65537)), /65536/);
    await assert.rejects(f.bridge.embed(''), /65536/);
    f.bridge.stop();
    await assert.rejects(f.bridge.embed('late'), /stopped/);
    assert.equal(f.messages.filter(m => m.t === 'embed').length, 0);
  } finally { await f.close(); }
});

test('rings are still handled while an embed is pending', async () => {
  const f = await fixture(() => {});
  try {
    const pending = f.bridge.embed('waiting');
    await f.until(() => f.messages.some(m => m.t === 'embed'));
    // No unread room: the bridge refuses the ring, proving the ring path still runs.
    answer(f.sockets[0], { t: 'ring', ring: 'r1', room: 'a'.repeat(64), unread: 1 });
    await f.until(() => f.messages.some(m => m.t === 'refused' && m.ring === 'r1'));
    f.sockets[0].destroy();
    await assert.rejects(pending, /disconnected/);
  } finally { await f.close(); }
});

test('serve --semantic --backbone embeds through the router, never loading a model', {timeout:30000}, async () => {
  const { spawn } = await import('node:child_process');
  const { existsSync, readFileSync } = await import('node:fs');
  const f = await fixture((m, s) => answer(s, { t: 'embedded', id: m.id, vector: vector(1) }));
  f.bridge.stop();
  const dir = mkdtempSync(join(tmpdir(), 'vortex-backbone-serve-'));
  const path = f.path;
  const child = spawn('bun', ['src/cli.ts', 'serve', '--dir', dir, '--name', 'sem', '--port', '0', '--semantic', '--backbone', path],
    { stdio: 'ignore', env: { ...process.env, VORTEX_TEST_FORBID_MODEL_LOAD: '1' } });
  try {
    const end = Date.now() + 8000;
    while (!existsSync(join(dir, 'endpoint.json'))) { assert.ok(Date.now() < end, 'service start'); await new Promise(r => setTimeout(r, 20)); }
    await f.until(() => f.messages.filter(m => m.t === 'hello').length >= 2);
    const ep = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8'));
    const response = await fetch(ep.url + '/create', { method: 'POST', headers: { authorization: 'Bearer ' + ep.token, 'content-type': 'application/json' },
      body: JSON.stringify({ session: 'live', statement: 'flaky integration tests' }) });
    const body: any = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.match(body.conference.id, /^[0-9a-f]{32}$/);
    assert.ok(f.messages.some(m => m.t === 'embed' && m.text === 'task: clustering | query: flaky integration tests'));
  } finally {
    await new Promise<void>(r => { child.once('exit', () => r()); child.kill('SIGTERM'); });
    rmSync(dir, { recursive: true, force: true });
    await f.close();
  }
});
