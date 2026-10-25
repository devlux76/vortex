// The Claude ring adapter's topic picker (2026-10-23): it reads the service's
// unread view (no acknowledged or already-handled events) and, when a ring
// names its charged room (VORTEX_ROOM), takes its run from that room only, so
// another room's ring budget never pays for this room's mail; a --room ack
// through the run then leaves every other room's mail unread.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const conf = 'c'.repeat(32), direct = '["a","stale"]';
const post = (cursor: number) => ({ cursor, kind: 'conference_message', room: 'conference:' + conf, peer: 'p',
  conference: conf, session: 'other', body: 'b' + cursor, trust: 'untrusted_peer_content' });
const dm = (cursor: number) => ({ cursor, kind: 'message', room: direct, peer: 'stale', body: 'stale', trust: 'untrusted_peer_content' });

async function withService(state: object, body: (dir: string, call: (op: string, args: object) => Promise<any>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'vortex-claude-topics-'));
  const dir = join(root, 'claude');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state), { mode: 0o600 });
  let service: ChildProcess | undefined;
  try {
    service = spawn('bun', ['src/cli.ts', 'serve', '--dir', dir, '--name', 'claude', '--port', '0'], { stdio: 'ignore' });
    const end = Date.now() + 8000;
    while (!existsSync(join(dir, 'endpoint.json'))) {
      assert.equal(service.exitCode, null); assert.ok(Date.now() < end, 'service start');
      await new Promise(r => setTimeout(r, 20));
    }
    const ep = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8'));
    const call = async (op: string, args: object) => {
      const r = await fetch(ep.url + '/' + op, { method: 'POST', headers: { authorization: 'Bearer ' + ep.token, 'content-type': 'application/json' }, body: JSON.stringify(args) });
      const value: any = await r.json(); assert.equal(r.status, 200, JSON.stringify(value)); return value;
    };
    await body(dir, call);
  } finally {
    if (service && service.exitCode === null) await new Promise<void>(r => { service!.once('exit', () => r()); service!.kill('SIGTERM'); });
    rmSync(root, { recursive: true, force: true });
  }
}
const topics = (dir: string, env: Record<string, string> = {}) => {
  const run = spawnSync('bun', ['skills/vortex/adapters/claude-topics.mjs'], { encoding: 'utf8',
    env: { ...process.env, VORTEX_DIR: dir, CLAUDE_CONFIG_DIR: join(dir, '..'), ...env } });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
};

test('claude-topics never offers an event a scoped session already handled', { timeout: 30000 }, async () => {
  await withService({ rooms: {}, seen: [], cursor: 3, acked: 0, handled: [2], events: [post(1), post(2), post(3)] }, async dir => {
    const topic = topics(dir);
    assert.equal(topic.key, 'conference:' + conf);
    assert.deepEqual([topic.first, topic.through, topic.count], [1, 3, 2], 'the handled event is neither counted nor shown');
  });
});

test('a ring charged to one room takes its run from that room, and its --room ack leaves the other room unread', { timeout: 30000 }, async () => {
  await withService({ rooms: {}, seen: [], cursor: 3, acked: 0, events: [dm(1), post(2), post(3)] }, async (dir, call) => {
    assert.equal(topics(dir).first, 1, 'without a charged room the global head is taken');
    const topic = topics(dir, { VORTEX_ROOM: 'conference:' + conf });
    assert.deepEqual([topic.key, topic.first, topic.through, topic.room], ['conference:' + conf, 2, 3, 'conference:' + conf]);
    assert.deepEqual(await call('ack', { cursor: topic.through, room: topic.room }), { acked: 3, room: 'conference:' + conf });
    assert.deepEqual((await call('read', {})).events.map((e: any) => e.cursor), [1], 'the other room keeps its unread mail');
    assert.deepEqual((await call('read', { room: direct })).events.map((e: any) => e.cursor), [1]);
  });
});
