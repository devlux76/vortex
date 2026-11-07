// Docs: VORTEX_v5.1.md §9.3; skills/vortex/SKILL.md — Being woken when idle; ISSUES.md I6/I10.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WRAPPER, ADAPTER, SESSION, CREATED, TRUSTED, PEER_MARKER, type LoggedRequest, PASSWORD, BASIC, startFixture, sleep, promptTarget, CONF_A, CONF_B, awaitPrompt } from './opencode-adapter.testkit.ts'

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
