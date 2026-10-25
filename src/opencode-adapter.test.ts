// Docs: VORTEX_v5.1.md §9.3; skills/vortex/SKILL.md — Being woken when idle; ISSUES.md I6/I10.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WRAPPER = resolve('skills/vortex/adapters/opencode.sh');
const ADAPTER = resolve('skills/vortex/adapters/opencode.mjs');
const SESSION = 'ses_testfixture000000000001';
const CREATED = 'ses_createdbyadapter0000001';
const TRUSTED = '12D3KooWTestFixturePeerXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const PEER_MARKER = 'PEER_BODY_MUST_NOT_BECOME_PROMPT';

interface LoggedRequest { method: string; url: string; body: unknown; auth?: string }
const PASSWORD = 'fixture-password';
const BASIC = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;

async function startFixture(acked: number, opts: {
  statusSeq?: Array<'idle' | 'busy' | 'retry'>;
  statusBySession?: Record<string, { type: string }>;
  omitFromStatus?: boolean;
  forms?: Array<{ id: string }>;
  permissions?: Array<{ id: string }>;
  statusDelayMs?: number;
  ackOnFinalPermission?: boolean;
  unpinned?: boolean;
  keptCreatedAt?: number;
  events?: Array<any>;
  sseEvents?: Array<any>;
  sseChunks?: Array<string>;
  sseChunkDelayMs?: number;
  idleAfterSse?: boolean;
  handled?: number[];
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'vortex-opencode-adapter-'));
  const projectDir = join(root, 'proj');
  const dir = join(projectDir, '.vortex', 'opencode');
  mkdirSync(dir, { recursive: true });
  const stateFile = join(dir, 'state.json');
  const events = opts.events ?? [{ cursor: 2, kind: 'message', room: 'r', peer: 'p', body: PEER_MARKER }];
  const cursor = events.length ? events[events.length - 1].cursor : acked;
  const snapshot = (c: number, a: number) =>
    ({ rooms: {}, events, seen: [], cursor: c, acked: a, ...(opts.handled ? { handled: opts.handled } : {}) });
  writeFileSync(stateFile, JSON.stringify(snapshot(cursor, acked)));
  const requests: LoggedRequest[] = [];
  const statusSeq = opts.statusSeq ?? ['idle'];
  let statusPolls = 0;
  let permissionChecks = 0;
  let sseDelivered = false;
  // OpenCode 2.x session shape: the directory lives under location.
  const sessionDoc = {
    id: SESSION, projectID: 'p', location: { directory: projectDir },
    title: 't', time: { created: 1, updated: 2 },
    agent: 'build',
    model: { id: 'muse-spark-1.3-contributor-free', providerID: 'opencode', variant: 'default' },
  };
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : undefined, auth: req.headers.authorization });
      const u = new URL(req.url ?? '/', 'http://x');
      const json = (code: number, value: unknown) => {
        if (res.destroyed) return;
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      // The active map lists only running sessions.
      const active = (m: Record<string, { type: string }>) =>
        ({ data: Object.fromEntries(Object.entries(m).filter(([, v]) => v.type !== 'idle').map(([k]) => [k, { type: 'running' }])) });
      if (req.headers.authorization !== BASIC) { res.writeHead(401); res.end('{}'); }
      else if (req.method === 'GET' && u.pathname === `/api/session/${SESSION}`)
        json(200, { data: { ...sessionDoc, time: { created: opts.keptCreatedAt ?? 1, updated: 2 } } });
      else if (req.method === 'GET' && u.pathname === `/api/session/${CREATED}`)
        json(200, { data: { ...sessionDoc, id: CREATED, location: { directory: projectDir }, time: { created: 1, updated: 2 }, agent: undefined } });
      else if (req.method === 'GET' && u.pathname === '/api/session/active') {
        const type = statusSeq[Math.min(statusPolls++, statusSeq.length - 1)];
        if (opts.statusBySession) json(200, active(sseDelivered && opts.idleAfterSse ? {} : opts.statusBySession));
        else setTimeout(() => json(200, active(opts.omitFromStatus ? {} : { [SESSION]: { type } })), opts.statusDelayMs ?? 0);
      }
      else if (req.method === 'GET' && u.pathname === '/api/event') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        // Like the real server: a connected event first, real newlines, and
        // the active map turns idle only once the stream has said so.
        res.write('data: {"id":"evt_1","type":"server.connected","data":{}}\n\n');
        if (opts.sseChunks) {
          (async () => {
            for (const chunk of opts.sseChunks!) {
              await new Promise((r) => setTimeout(r, opts.sseChunkDelayMs ?? 0));
              if (res.destroyed) return;
              if (chunk === opts.sseChunks![opts.sseChunks!.length - 1]) sseDelivered = true;
              res.write(chunk);
            }
          })();
        } else {
          for (const e of (opts.sseEvents ?? [])) res.write(`data: ${JSON.stringify(e)}\n\n`);
        }
        res.on('close', () => { try { res.end(); } catch {} });
      }
      else if (req.method === 'GET' && u.pathname.endsWith('/form')) json(200, { data: opts.forms ?? [] });
      else if (req.method === 'GET' && u.pathname.endsWith('/permission')) {
        if(++permissionChecks===2 && opts.ackOnFinalPermission) writeFileSync(stateFile,JSON.stringify(snapshot(2,2)));
        json(200, { data: opts.permissions ?? [] });
      }
      else if (req.method === 'GET' && u.pathname.startsWith('/api/session/')) json(404, {});
      else if (req.method === 'GET' && u.pathname === '/api/model/default')
        json(200, { location: { directory: projectDir }, data: { providerID: 'opencode', id: 'muse-spark-1.3-contributor-free' } });
      else if (req.method === 'POST' && u.pathname === '/api/session') json(200, { data: { ...sessionDoc, id: CREATED, agent: undefined } });
      else if (req.method === 'POST' && (u.pathname === `/api/session/${SESSION}/prompt` || u.pathname === `/api/session/${CREATED}/prompt`))
        json(200, { data: { id: 'msg_1', type: 'user', delivery: 'queue' } });
      else { res.writeHead(404); res.end('{}'); }
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  const env: Record<string, string> = {
    ...process.env,
    VORTEX_DIR: dir,
    VORTEX_OPENCODE_URL: `http://127.0.0.1:${port}`,
    OPENCODE_PASSWORD: PASSWORD,
    ...(opts.unpinned ? {} : { VORTEX_OPENCODE_SESSION: SESSION }),
    VORTEX_ADAPTER_DEADLINE_MS: '8000',
    VORTEX_TRUSTED_PEERS: `codex=${TRUSTED}`,
    VORTEX_ADAPTER_POLL_MS: '50',
  } as Record<string, string>;
  return { root, projectDir, dir, stateFile, snapshot, server, requests, env };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
test('opencode adapter prompts the configured session and exits on ack', { timeout: 20000 }, async () => {
  const f = await startFixture(0);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn(WRAPPER, { env: f.env, stdio: 'ignore' });
    const end = Date.now() + 10000;
    let post: LoggedRequest | undefined;
    while (Date.now() < end) {
      post = f.requests.find((r) => r.method === 'POST');
      if (post) break;
      if (child?.exitCode != null) throw new Error('adapter exited before dispatch');
      await sleep(25);
    }
    assert.ok(post, 'expected one async prompt');
    assert.equal(post.url, `/api/session/${SESSION}/prompt`);
    // The session carries its model and agent; the prompt is text queued behind any running turn.
    const body = post.body as { text: string; delivery: string };
    assert.deepEqual(Object.keys(body).sort(), ['delivery', 'text']);
    assert.equal(body.delivery, 'queue');
    assert.match(body.text, /VORTEX ring/);
    assert.match(body.text, /vortex skill/);
    assert.match(body.text, /not typed by the operator/);
    assert.ok(body.text.includes(`${TRUSTED} (codex)`));
    assert.ok(!body.text.includes(PEER_MARKER), 'peer body must not become prompt');
    assert.ok(!body.text.includes('no human'), 'must not claim no human present');
    for (const r of f.requests) {
      const pathname = new URL(r.url, 'http://x').pathname;
      assert.equal(r.auth, BASIC, `request without the server password: ${r.url}`);
      assert.ok(pathname.startsWith('/api/'), `not a 2.x API path: ${r.url}`);
      assert.ok(r.method === 'GET' || pathname.endsWith('/prompt'), `unexpected request ${r.method} ${r.url}`);
    }
    assert.ok(!f.requests.some((r) => new URL(r.url, 'http://x').pathname === '/attach'), 'adapter must not register a host');
    writeFileSync(f.stateFile, JSON.stringify(f.snapshot(2, 2)));
    const running = child;
    assert.ok(running, 'adapter process started');
    const code = await new Promise<number | null>((resolve) => running.once('exit', resolve));
    assert.equal(code, 0);
  } finally { f.server.close(); child?.kill('SIGTERM'); rmSync(f.root, { recursive: true, force: true }); }
});

test('opencode adapter exits without HTTP when mail is already acknowledged', () => {
  return (async () => {
    const f = await startFixture(2);
    try {
      assert.equal(spawnSync('bun', [ADAPTER], { env: f.env }).status, 0);
      assert.deepEqual(f.requests, []);
    } finally { f.server.close(); rmSync(f.root, { recursive: true, force: true }); }
  })();
});

test('busy session defers with exit 75 and zero prompts', { timeout: 20000 }, async () => {
  const f = await startFixture(0, { statusSeq: ['busy'] });
  f.env.VORTEX_ADAPTER_DEADLINE_MS = '1200';
  f.env.VORTEX_OPENCODE_BUSY_DEADLINE_MS = '1200';
  try {
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn('bun', [ADAPTER], { env: f.env, stdio: 'ignore' });
      child.once('exit', resolve);
    });
    assert.equal(code, 75);
    assert.ok(f.requests.length > 0, 'expected status polls');
    assert.ok(f.requests.every((r) => r.method === 'GET'), 'zero prompts on busy');
    assert.equal(JSON.parse(readFileSync(f.stateFile, 'utf8')).acked, 0);
  } finally { f.server.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('deadline expiry during a status request is a deferral, not an adapter failure', async () => {
  const f = await startFixture(0, { statusSeq: ['busy'], statusDelayMs: 300 });
  f.env.VORTEX_ADAPTER_DEADLINE_MS = '150';
  f.env.VORTEX_OPENCODE_BUSY_DEADLINE_MS = '150';
  try {
    const child = spawn('bun', [ADAPTER], { env: f.env, stdio: 'ignore' });
    assert.equal(await new Promise<number|null>(resolve => child.once('exit', resolve)), 75);
    assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
  } finally { f.server.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('pending form blocks with exit 75 and reports the id', { timeout: 20000 }, async () => {
  const f = await startFixture(0, { forms: [{ id: 'frm_block1' }] });
  try {
    const child = spawn('bun', [ADAPTER], { env: f.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    assert.equal(code, 75);
    assert.match(stderr, /frm_block1/);
    assert.ok(f.requests.every((r) => r.method === 'GET'), 'zero prompts with pending form');
    assert.equal(JSON.parse(readFileSync(f.stateFile, 'utf8')).acked, 0);
  } finally { f.server.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('pending permission blocks with exit 75 and reports the id', { timeout: 20000 }, async () => {
  const f = await startFixture(0, { permissions: [{ id: 'prm_block1' }] });
  try {
    const child = spawn('bun', [ADAPTER], { env: f.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    assert.equal(code, 75);
    assert.match(stderr, /prm_block1/);
    assert.ok(f.requests.every((r) => r.method === 'GET'), 'zero prompts with pending permission');
    assert.equal(JSON.parse(readFileSync(f.stateFile, 'utf8')).acked, 0);
  } finally { f.server.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('late ack keeps the accepted prompt charged without treating it as a broken adapter', { timeout: 20000 }, async () => {
  const f = await startFixture(0);
  f.env.VORTEX_ADAPTER_DEADLINE_MS = '1200';
  f.env.VORTEX_OPENCODE_BUSY_DEADLINE_MS = '1200';
  try {
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn('bun', [ADAPTER], { env: f.env, stdio: 'ignore' });
      child.once('exit', resolve);
    });
    assert.equal(code, 76);
    assert.equal(f.requests.filter((r) => r.method === 'POST').length, 1);
  } finally { f.server.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('session absent from status is idle and dispatches', { timeout: 20000 }, async () => {
  const f = await startFixture(0, { omitFromStatus: true });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn('bun', [ADAPTER], { env: f.env, stdio: 'ignore' });
    const end = Date.now() + 10000;
    while (!f.requests.some((r) => r.method === 'POST')) {
      if (child?.exitCode != null) throw new Error('adapter exited before dispatch');
      if (Date.now() > end) throw new Error('no dispatch for idle-by-absence session');
      await sleep(25);
    }
    writeFileSync(f.stateFile, JSON.stringify(f.snapshot(2, 2)));
    const running = child;
    assert.ok(running, 'adapter process started');
    assert.equal(await new Promise<number | null>((resolve) => running.once('exit', resolve)), 0);
  } finally { f.server.close(); child?.kill('SIGTERM'); rmSync(f.root, { recursive: true, force: true }); }
});

test('acknowledgment while busy makes an OpenCode wake obsolete without dispatch', async () => {
  const f=await startFixture(0,{statusSeq:['busy']});
  f.env.VORTEX_ADAPTER_DEADLINE_MS='500';
  f.env.VORTEX_OPENCODE_BUSY_DEADLINE_MS='500';
  const child=spawn('bun',[ADAPTER],{env:f.env,stdio:'ignore'});
  try {
    const end=Date.now()+2000;
    while(!f.requests.some(request=>request.url.startsWith('/api/session/active'))) {
      if(child.exitCode!==null || Date.now()>end) throw Error('adapter did not check busy state');
      await sleep(10);
    }
    writeFileSync(f.stateFile,JSON.stringify(f.snapshot(2,2)));
    assert.equal(await new Promise<number|null>(resolve=>child.once('exit',resolve)),0);
    assert.equal(f.requests.filter(request=>request.method==='POST').length,0);
  } finally {f.server.close();child.kill('SIGTERM');rmSync(f.root,{recursive:true,force:true});}
});

test('OpenCode rechecks acknowledgment after its final permission check', async () => {
  const f=await startFixture(0,{ackOnFinalPermission:true});
  const child=spawn('bun',[ADAPTER],{env:f.env,stdio:'ignore'});
  try {
    assert.equal(await new Promise<number|null>(resolve=>child.once('exit',resolve)),0);
    assert.equal(f.requests.filter(request=>request.method==='POST').length,0);
  } finally {f.server.close();child.kill('SIGTERM');rmSync(f.root,{recursive:true,force:true});}
});

const promptTarget = async (f: Awaited<ReturnType<typeof startFixture>>) => {
  const child = spawn(WRAPPER, { env: f.env, stdio: 'ignore' });
  try {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      const post = f.requests.find((r) => r.method === 'POST' && r.url.includes('/prompt'));
      if (post) return new URL(post.url, 'http://x').pathname;
      if (child.exitCode != null) throw new Error('adapter exited before dispatch');
      await sleep(25);
    }
    throw new Error('no prompt was sent');
  } finally { child.kill('SIGTERM'); }
};

test('opencode adapter: new topic creates a session and persists map before prompt', { timeout: 20000 }, async () => {
  const f = await startFixture(0, { unpinned: true, events: [{ cursor: 1, kind: 'message', room: 'r1', body: 'hi', peer: 'p', trust: 'untrusted_peer_content' }] });
  try {
    assert.equal(await promptTarget(f), `/api/session/${CREATED}/prompt`);
    assert.equal(readFileSync(join(f.dir, 'opencode-topics.json'), 'utf8').includes('direct:r1'), true);
    const map = JSON.parse(readFileSync(join(f.dir, 'opencode-topics.json'), 'utf8'));
    assert.equal(map['direct:r1'].session, CREATED);
    const created = f.requests.find((r) => r.method === 'POST' && new URL(r.url, 'http://x').pathname === '/api/session');
    assert.deepEqual((created?.body as { model: unknown }).model, { providerID: 'opencode', id: 'muse-spark-1.3-contributor-free' });
    assert.equal((created?.body as { title: string }).title, 'VORTEX: direct:r1');
  } finally { f.server.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('opencode adapter: same topic on next ring reuses its session', { timeout: 20000 }, async () => {
  const conf = 'c'.repeat(32);
  const f = await startFixture(0, { unpinned: true, events: [{ cursor: 1, kind: 'conference_message', room: 'r1', body: 'a', peer: 'p', trust: 'untrusted_peer_content', conference: conf }] });
  try {
    assert.equal(await promptTarget(f), `/api/session/${CREATED}/prompt`);
    writeFileSync(f.stateFile, JSON.stringify({ rooms: {}, events: [
      { cursor: 1, kind: 'conference_message', room: 'r1', body: 'a', peer: 'p', trust: 'untrusted_peer_content', conference: conf },
      { cursor: 2, kind: 'conference_message', room: 'r1', body: 'b', peer: 'p', trust: 'untrusted_peer_content', conference: conf },
    ], seen: [], cursor: 2, acked: 1 }));
    // second ring should reuse CREATED
    const f2 = f;
    const child = spawn('bun', [ADAPTER], { env: f2.env, stdio: 'ignore' });
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      const post = f2.requests.find((r) => r.method === 'POST' && r.url.includes('/prompt') && r.url.includes(CREATED));
      if (post && f2.requests.filter((r) => r.method === 'POST' && r.url.includes('/prompt')).length >= 2) break;
      if (child.exitCode != null) throw new Error('adapter exited before dispatch');
      await sleep(25);
    }
    assert.ok(f2.requests.some((r) => r.method === 'POST' && r.url.includes(`/api/session/${CREATED}/prompt`)), 'expected reuse of created session');
  } finally { f.server.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('an old idle kept session is replaced by a new one', { timeout: 20000 }, async () => {
  const f = await startFixture(0, { unpinned: true, keptCreatedAt: 1 });
  try {
    writeFileSync(join(f.dir, 'wake-session'), SESSION);
    assert.equal(await promptTarget(f), `/api/session/${CREATED}/prompt`);
  } finally { f.server.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('a kept session that no longer exists is replaced', { timeout: 20000 }, async () => {
  const f = await startFixture(0, { unpinned: true });
  try {
    writeFileSync(join(f.dir, 'wake-session'), 'ses_deletedlongago00000001');
    assert.equal(await promptTarget(f), `/api/session/${CREATED}/prompt`);
  } finally { f.server.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('OpenCode adapter ignores an online-until lease and registers no host', { timeout: 20000 }, async () => {
  const f = await startFixture(0);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    writeFileSync(join(f.dir, 'online-until'), String(Date.now() + 60 * 60 * 1000));
    child = spawn('bun', [ADAPTER], { env: f.env, stdio: 'ignore' });
    const end = Date.now() + 10000;
    while (!f.requests.some((r) => r.method === 'POST' && r.url.includes('/prompt'))) {
      if (child.exitCode != null) throw new Error('adapter exited before dispatch');
      if (Date.now() > end) throw new Error('an online-until lease suppressed the wake');
      await sleep(25);
    }
    assert.ok(!f.requests.some((r) => new URL(r.url, 'http://x').pathname === '/attach'), 'adapter must not register a host');
    writeFileSync(f.stateFile, JSON.stringify(f.snapshot(2, 2)));
    const running = child;
    assert.ok(running, 'adapter process started');
    assert.equal(await new Promise<number | null>((resolve) => running.once('exit', resolve)), 0);
  } finally { f.server.close(); child?.kill('SIGTERM'); rmSync(f.root, { recursive: true, force: true }); }
});

const CONF_A = 'a'.repeat(32);
const CONF_B = 'b'.repeat(32);

test('opencode adapter: interleaved topics handles only first run', { timeout: 20000 }, async () => {
  const f = await startFixture(0, { unpinned: true, events: [
    { cursor: 1, kind: 'conference_message', room: 'r1', body: 'a', peer: 'p', trust: 'untrusted_peer_content', conference: CONF_A },
    { cursor: 2, kind: 'conference_message', room: 'r2', body: 'b', peer: 'p', trust: 'untrusted_peer_content', conference: CONF_B },
    { cursor: 3, kind: 'conference_message', room: 'r3', body: 'a2', peer: 'p', trust: 'untrusted_peer_content', conference: CONF_A },
  ] });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn('bun', [ADAPTER], { env: f.env, stdio: 'ignore' });
    const end = Date.now() + 10000;
    let post: LoggedRequest | undefined;
    while (Date.now() < end) {
      post = f.requests.find((r) => r.method === 'POST' && r.url.includes('/prompt'));
      if (post) break;
      if (child?.exitCode != null) throw new Error('adapter exited before dispatch');
      await sleep(25);
    }
    assert.ok(post, 'expected one async prompt');
    const body = post.body as { text: string };
    assert.match(body.text, /Process ONLY events with cursors from 1 through 1 \(inclusive\)/);
    assert.match(body.text, /Finish by acking 1, nothing later/);
  } finally { f.server.close(); child?.kill('SIGTERM'); rmSync(f.root, { recursive: true, force: true }); }
});

const awaitPrompt = async (f: Awaited<ReturnType<typeof startFixture>>, child: ReturnType<typeof spawn>) => {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const post = f.requests.find((r) => r.method === 'POST' && r.url.includes('/prompt'));
    if (post) return (post.body as { text: string }).text;
    if (child.exitCode != null) throw new Error('adapter exited before dispatch');
    await sleep(25);
  }
  throw new Error('expected one async prompt');
};

// Head-of-line (2026-10-23): an event a scoped live session already handled
// is not part of the adapter's run (it is neither offered nor re-handled).
test('opencode adapter: a handled event is left out of the run', { timeout: 20000 }, async () => {
  const f = await startFixture(0, { unpinned: true, handled: [2], events: [
    { cursor: 1, kind: 'conference_message', room: 'r1', body: 'a', peer: 'p', trust: 'untrusted_peer_content', conference: CONF_A },
    { cursor: 2, kind: 'conference_message', room: 'r1', body: 'a2', peer: 'p', trust: 'untrusted_peer_content', conference: CONF_A },
    { cursor: 3, kind: 'conference_message', room: 'r1', body: 'a3', peer: 'p', trust: 'untrusted_peer_content', conference: CONF_A },
  ] });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn('bun', [ADAPTER], { env: f.env, stdio: 'ignore' });
    assert.match(await awaitPrompt(f, child), /Process ONLY events with cursors from 1 through 3 \(inclusive\)/);
  } finally { f.server.close(); child?.kill('SIGTERM'); rmSync(f.root, { recursive: true, force: true }); }
});

// Charged room (2026-10-23): the router charged room rA, so the run comes from
// rA even though another room's mail is older, the prompt acks with --room,
// and a --room ack (handled set, watermark unmoved) completes the run.
test('opencode adapter: a ring charged to one room handles that room and completes on its --room ack', { timeout: 20000 }, async () => {
  const events = [
    { cursor: 1, kind: 'message', room: 'r0', body: 'older', peer: 'p', trust: 'untrusted_peer_content' },
    { cursor: 2, kind: 'conference_message', room: 'rA', body: 'a', peer: 'p', trust: 'untrusted_peer_content', conference: CONF_A },
    { cursor: 3, kind: 'conference_message', room: 'rA', body: 'a2', peer: 'p', trust: 'untrusted_peer_content', conference: CONF_A },
  ];
  const f = await startFixture(0, { unpinned: true, events });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn('bun', [ADAPTER], { env: { ...f.env, VORTEX_ROOM: 'rA' }, stdio: 'ignore' });
    const text = await awaitPrompt(f, child);
    assert.match(text, /Process ONLY events with cursors from 2 through 3 \(inclusive\)/);
    assert.match(text, /--room "rA"/);
    assert.match(text, /never ack without --room/);
    writeFileSync(f.stateFile, JSON.stringify({ rooms: {}, events, seen: [], cursor: 3, acked: 0, handled: [2, 3] }));
    const running = child;
    assert.equal(await new Promise<number | null>((resolve) => running.once('exit', resolve)), 0);
  } finally { f.server.close(); child?.kill('SIGTERM'); rmSync(f.root, { recursive: true, force: true }); }
});

test('opencode adapter: conference event and routed DM share a session',{ timeout: 20000 }, async () => {
  const conf = 'c'.repeat(32);
  const f = await startFixture(0, { unpinned: true, events: [
    { cursor: 1, kind: 'conference_message', room: 'r1', body: 'a', peer: 'p', trust: 'untrusted_peer_content', conference: conf },
    { cursor: 2, kind: 'message', room: 'r2', body: 'b', peer: 'p', trust: 'untrusted_peer_content', routingConference: conf },
  ] });
  try {
    assert.equal(await promptTarget(f), `/api/session/${CREATED}/prompt`);
    const map = JSON.parse(readFileSync(join(f.dir, 'opencode-topics.json'), 'utf8'));
    const keys = Object.keys(map);
    assert.equal(keys.length, 1);
    assert.equal(keys[0], `conference:${conf}`);
  } finally { f.server.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('opencode adapter: direct message gets direct:<room> key', { timeout: 20000 }, async () => {
  const f = await startFixture(0, { unpinned: true, events: [{ cursor: 7, kind: 'message', room: 'r1', body: 'hi', peer: 'p', trust: 'untrusted_peer_content' }] });
  try {
    assert.equal(await promptTarget(f), `/api/session/${CREATED}/prompt`);
    const map = JSON.parse(readFileSync(join(f.dir, 'opencode-topics.json'), 'utf8'));
    assert.ok(Object.prototype.hasOwnProperty.call(map, 'direct:r1'));
  } finally { f.server.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('opencode adapter: two consecutive DMs in one room are one run', { timeout: 20000 }, async () => {
  const f = await startFixture(0, { unpinned: true, events: [
    { cursor: 1, kind: 'message', room: 'r1', body: 'hi', peer: 'p', trust: 'untrusted_peer_content' },
    { cursor: 2, kind: 'message', room: 'r1', body: 'hi2', peer: 'p', trust: 'untrusted_peer_content' },
  ] });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn('bun', [ADAPTER], { env: f.env, stdio: 'ignore' });
    const text = await awaitPrompt(f, child);
    assert.match(text, /Process ONLY events with cursors from 1 through 2 \(inclusive\)/);
    assert.equal(f.requests.filter((r) => r.method === 'POST' && r.url.includes('/prompt')).length, 1);
    writeFileSync(f.stateFile, JSON.stringify(f.snapshot(2, 2)));
    const running = child;
    assert.equal(await new Promise<number | null>((resolve) => running.once('exit', resolve)), 0);
  } finally { f.server.close(); child?.kill('SIGTERM'); rmSync(f.root, { recursive: true, force: true }); }
});

test('opencode adapter: DM in a second room gets a different session', { timeout: 20000 }, async () => {
  const f = await startFixture(0, { unpinned: true, events: [{ cursor: 1, kind: 'message', room: 'r1', body: 'hi', peer: 'p', trust: 'untrusted_peer_content' }] });
  try {
    assert.equal(await promptTarget(f), `/api/session/${CREATED}/prompt`);
    const createdPosts1 = f.requests.filter((r) => r.method === 'POST' && new URL(r.url, 'http://x').pathname === '/api/session').length;
    // second room
    writeFileSync(f.stateFile, JSON.stringify({ rooms: {}, events: [
      { cursor: 2, kind: 'message', room: 'r2', body: 'hi', peer: 'p', trust: 'untrusted_peer_content' },
    ], seen: [], cursor: 2, acked: 1 }));
    const child = spawn('bun', [ADAPTER], { env: f.env, stdio: 'ignore' });
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      if (f.requests.filter((r) => r.method === 'POST' && r.url.includes('/prompt')).length >= 2) break;
      if (child.exitCode != null) throw new Error('adapter exited before dispatch');
      await sleep(25);
    }
    const createdPosts2 = f.requests.filter((r) => r.method === 'POST' && new URL(r.url, 'http://x').pathname === '/api/session').length;
    assert.equal(createdPosts2, createdPosts1 + 1, 'expected a new session for the second room');
    writeFileSync(f.stateFile, JSON.stringify({ rooms: {}, events: [
      { cursor: 2, kind: 'message', room: 'r2', body: 'hi', peer: 'p', trust: 'untrusted_peer_content' },
    ], seen: [], cursor: 2, acked: 2 }));
    const running = child;
    assert.equal(await new Promise<number | null>((resolve) => running.once('exit', resolve)), 0);
  } finally { f.server.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('opencode adapter: later DM in first room reuses its session', { timeout: 20000 }, async () => {
  const f = await startFixture(0, { unpinned: true, events: [{ cursor: 1, kind: 'message', room: 'r1', body: 'hi', peer: 'p', trust: 'untrusted_peer_content' }] });
  try {
    assert.equal(await promptTarget(f), `/api/session/${CREATED}/prompt`);
    // later DM in same room
    writeFileSync(f.stateFile, JSON.stringify({ rooms: {}, events: [
      { cursor: 1, kind: 'message', room: 'r1', body: 'hi', peer: 'p', trust: 'untrusted_peer_content' },
      { cursor: 2, kind: 'message', room: 'r1', body: 'hi2', peer: 'p', trust: 'untrusted_peer_content' },
    ], seen: [], cursor: 2, acked: 1 }));
    const child = spawn('bun', [ADAPTER], { env: f.env, stdio: 'ignore' });
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      if (f.requests.filter((r) => r.method === 'POST' && r.url.includes('/prompt')).length >= 2) break;
      if (child.exitCode != null) throw new Error('adapter exited before dispatch');
      await sleep(25);
    }
    assert.ok(f.requests.some((r) => r.method === 'POST' && r.url.includes(`/api/session/${CREATED}/prompt`)), 'expected reuse of created session');
    const createdPosts = f.requests.filter((r) => r.method === 'POST' && new URL(r.url, 'http://x').pathname === '/api/session').length;
    assert.equal(createdPosts, 1, 'no new session should be created');
    writeFileSync(f.stateFile, JSON.stringify({ rooms: {}, events: [
      { cursor: 2, kind: 'message', room: 'r1', body: 'hi2', peer: 'p', trust: 'untrusted_peer_content' },
    ], seen: [], cursor: 2, acked: 2 }));
    const running = child;
    assert.equal(await new Promise<number | null>((resolve) => running.once('exit', resolve)), 0);
  } finally { f.server.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('opencode adapter: busy session of topic A defers topic B with 75 and zero prompt POSTs', { timeout: 20000 }, async () => {
  const confB = 'd'.repeat(32);
  const f = await startFixture(0, { unpinned: true, statusBySession: { [SESSION]: { type: 'busy' } }, events: [
    { cursor: 1, kind: 'conference_message', room: 'r1', body: 'b', peer: 'p', trust: 'untrusted_peer_content', conference: confB },
  ] });
  f.env.VORTEX_OPENCODE_BUSY_DEADLINE_MS = '1200';
  try {
    const child = spawn('bun', [ADAPTER], { env: f.env, stdio: 'ignore' });
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    assert.equal(code, 75);
    assert.equal(f.requests.filter((r) => r.method === 'POST' && r.url.includes('/prompt')).length, 0);
  } finally { f.server.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('opencode adapter: deleted session for known key is recreated and map updated', { timeout: 20000 }, async () => {
  const conf = 'e'.repeat(32);
  const f = await startFixture(0, { unpinned: true, events: [{ cursor: 1, kind: 'conference_message', room: 'r1', body: 'a', peer: 'p', trust: 'untrusted_peer_content', conference: conf }] });
  try {
    // prepopulate map with a deleted session id
    writeFileSync(join(f.dir, 'opencode-topics.json'), JSON.stringify({ [`conference:${conf}`]: { session: 'ses_deletedlongago00000001', created: 1, last: 1 } }));
    assert.equal(await promptTarget(f), `/api/session/${CREATED}/prompt`);
    const map = JSON.parse(readFileSync(join(f.dir, 'opencode-topics.json'), 'utf8'));
    assert.equal(map[`conference:${conf}`].session, CREATED);
  } finally { f.server.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('opencode adapter: no peer text appears in prompt', { timeout: 20000 }, async () => {
  const f = await startFixture(0, { unpinned: true, events: [{ cursor: 1, kind: 'message', room: 'r1', body: PEER_MARKER, peer: 'p', trust: 'untrusted_peer_content' }] });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn('bun', [ADAPTER], { env: f.env, stdio: 'ignore' });
    const end = Date.now() + 10000;
    let post: LoggedRequest | undefined;
    while (Date.now() < end) {
      post = f.requests.find((r) => r.method === 'POST' && r.url.includes('/prompt'));
      if (post) break;
      if (child?.exitCode != null) throw new Error('adapter exited before dispatch');
      await sleep(25);
    }
    assert.ok(post);
    const joined = (post.body as { text: string }).text + f.requests.map(r => r.url).join('\u0000');
    assert.ok(!joined.includes(PEER_MARKER));
    writeFileSync(f.stateFile, JSON.stringify(f.snapshot(1, 1)));
    const running = child;
    assert.equal(await new Promise<number | null>((resolve) => running.once('exit', resolve)), 0);
  } finally { f.server.close(); child?.kill('SIGTERM'); rmSync(f.root, { recursive: true, force: true }); }
});

test('opencode adapter: SSE event split across chunks is still parsed', { timeout: 20000 }, async () => {
  const f = await startFixture(0, { unpinned: true, statusBySession: { [SESSION]: { type: 'busy' } }, idleAfterSse: true, sseChunkDelayMs: 300,
    sseChunks: [
      'data: {"id":"evt_2","type":"session.execution.succeeded","data":{"sessionID":"ses_testfixture000000000001"}}',
      '\n\n',
    ],
    events: [{ cursor: 1, kind: 'message', room: 'r1', body: 'hi', peer: 'p', trust: 'untrusted_peer_content' }],
  });
  f.env.VORTEX_ADAPTER_DEADLINE_MS = '30000';
  f.env.VORTEX_OPENCODE_BUSY_DEADLINE_MS = '30000';
  try {
    const child = spawn('bun', [ADAPTER], { env: f.env, stdio: 'ignore' });
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      if (f.requests.some((r) => r.method === 'POST' && r.url.includes('/prompt'))) break;
      if (child.exitCode != null) throw new Error('adapter exited before dispatch');
      await sleep(25);
    }
    assert.ok(f.requests.some((r) => r.method === 'POST' && r.url.includes('/prompt')), 'dispatched within 3s');
    assert.ok(f.requests.filter((r) => r.url.startsWith('/api/session/active')).length <= 4, 'woken by the event stream, not by polling');
    writeFileSync(f.stateFile, JSON.stringify(f.snapshot(1, 1)));
    assert.equal(await new Promise<number | null>((resolve) => child.once('exit', resolve)), 0);
  } finally { f.server.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('opencode adapter: busy session finishing via session.execution.succeeded dispatches promptly', { timeout: 20000 }, async () => {
  const f = await startFixture(0, { unpinned: true, statusBySession: { [SESSION]: { type: 'busy' } }, idleAfterSse: true, sseChunkDelayMs: 300,
    sseChunks: [
      'data: {"id":"evt_2","type":"session.execution.succeeded","data":{"sessionID":"ses_testfixture000000000001"}}\n\n',
    ],
    events: [{ cursor: 1, kind: 'message', room: 'r1', body: 'hi', peer: 'p', trust: 'untrusted_peer_content' }],
  });
  f.env.VORTEX_ADAPTER_DEADLINE_MS = '30000';
  f.env.VORTEX_OPENCODE_BUSY_DEADLINE_MS = '30000';
  try {
    const child = spawn('bun', [ADAPTER], { env: f.env, stdio: 'ignore' });
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      if (f.requests.some((r) => r.method === 'POST' && r.url.includes('/prompt'))) break;
      if (child.exitCode != null) throw new Error('adapter exited before dispatch');
      await sleep(25);
    }
    assert.ok(f.requests.some((r) => r.method === 'POST' && r.url.includes('/prompt')), 'dispatched within 3s');
    assert.ok(f.requests.filter((r) => r.url.startsWith('/api/session/active')).length <= 4, 'woken by the event stream, not by polling');
    writeFileSync(f.stateFile, JSON.stringify(f.snapshot(1, 1)));
    assert.equal(await new Promise<number | null>((resolve) => child.once('exit', resolve)), 0);
  } finally { f.server.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('opencode adapter: busy session going idle via session.idle dispatches promptly', { timeout: 20000 }, async () => {
  const f = await startFixture(0, { unpinned: true, statusBySession: { [SESSION]: { type: 'busy' } }, idleAfterSse: true, sseChunkDelayMs: 300,
    sseChunks: [
      'data: {"id":"evt_2","type":"session.idle","data":{"sessionID":"ses_testfixture000000000001"}}\n\n',
    ],
    events: [{ cursor: 1, kind: 'message', room: 'r1', body: 'hi', peer: 'p', trust: 'untrusted_peer_content' }],
  });
  f.env.VORTEX_ADAPTER_DEADLINE_MS = '30000';
  f.env.VORTEX_OPENCODE_BUSY_DEADLINE_MS = '30000';
  try {
    const child = spawn('bun', [ADAPTER], { env: f.env, stdio: 'ignore' });
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      if (f.requests.some((r) => r.method === 'POST' && r.url.includes('/prompt'))) break;
      if (child.exitCode != null) throw new Error('adapter exited before dispatch');
      await sleep(25);
    }
    assert.ok(f.requests.some((r) => r.method === 'POST' && r.url.includes('/prompt')), 'dispatched within 3s');
    assert.ok(f.requests.filter((r) => r.url.startsWith('/api/session/active')).length <= 4, 'woken by the event stream, not by polling');
    writeFileSync(f.stateFile, JSON.stringify(f.snapshot(1, 1)));
    assert.equal(await new Promise<number | null>((resolve) => child.once('exit', resolve)), 0);
  } finally { f.server.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('control events never create model threads or prompts', { timeout: 20000 }, async () => {
  const f = await startFixture(0, { unpinned: true, events: [{ cursor: 1, kind: 'match', room: 'r1', peer: 'p', trust: 'untrusted_peer_content' }] });
  try {
    const child = spawn(WRAPPER, { env: f.env, stdio: 'ignore' });
    const exit = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    assert.equal(exit, 0);
    assert.equal(f.requests.filter((r) => r.method === 'POST').length, 0);
    assert.equal(existsSync(join(f.dir, 'opencode-topics.json')), false);
  } finally { f.server.close(); rmSync(f.root, { recursive: true, force: true }); }
});
