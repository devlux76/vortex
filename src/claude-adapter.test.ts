// Docs: VORTEX_v5.1.md §§9.3, 10.5; skills/vortex/SKILL.md — Being woken when idle; ISSUES.md I7.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ADAPTER = resolve('skills/vortex/adapters/claude.sh');
const HELPER = resolve('skills/vortex/adapters/claude-topics.mjs');
const realBun = spawnSync('sh', ['-c', 'command -v bun'], { encoding: 'utf8' }).stdout.trim();

function makeCli(dir: string) {
  const fake = join(dir, 'cli.mjs');
  writeFileSync(fake, `import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'read') {
  const st = JSON.parse(readFileSync(process.env.VORTEX_DIR + '/state.json', 'utf8'));
  const idx = args.indexOf('--after');
  const after = idx >= 0 ? Number(args[idx + 1]) : (st.acked ?? 0);
  const ev = st.events.filter((e) => e.cursor > after);
  console.log(JSON.stringify({ events: ev, cursor: ev.at(-1)?.cursor ?? after }));
}
`);
  return fake;
}

function makeBun(dir: string, fakeCli: string) {
  writeFileSync(join(dir, 'bun'), `#!/bin/sh
if [ "$1" = "src/cli.ts" ]; then shift; exec '${realBun}' '${fakeCli}' "$@"; fi
if [ "$1" = "skills/vortex/adapters/claude-topics.mjs" ]; then exec '${realBun}' '${HELPER}' "$@"; fi
exec '${realBun}' "$@"
`, { mode: 0o700 });
}

function makeTimeout(dir: string, code: number, extra: string = '') {
  writeFileSync(join(dir, 'timeout'), `#!/bin/sh
${extra}
for a in "$@"; do printf '%s\\0' "$a"; done > '${join(dir, 'args')}'
exit ${code}
`, { mode: 0o700 });
}

function runAdapter(dir: string, envExtra: Record<string,string> = {}) {
  const env = { ...process.env, PATH: dir + ':' + process.env.PATH, VORTEX_DIR: dir, ...envExtra };
  const status = spawnSync(ADAPTER, [], { env }).status;
  const args = existsSync(join(dir, 'args'))
    ? readFileSync(join(dir, 'args'), 'utf8').split('\0').slice(0, -1)
    : null;
  let map = null;
  if (existsSync(join(dir, 'claude-topics.json'))) {
    try { map = JSON.parse(readFileSync(join(dir, 'claude-topics.json'), 'utf8')); } catch { map = 'CORRUPT'; }
  }
  return { status, args, map };
}

for (const [script, owner] of [['claude.sh', 'Claude'], ['codex.sh', 'Codex']]) test(`${owner} adapter is away by default`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'vortex-claude-away-'));
  try {
    writeFileSync(join(dir, 'timeout'), `#!/bin/sh\ntouch '${join(dir, 'agent-started')}'\n`, { mode: 0o700 });
    const fake = join(dir, 'cli.mjs');
    writeFileSync(fake, `import {appendFileSync} from 'node:fs';const a=process.argv.slice(2);appendFileSync('${join(dir,'calls')}',JSON.stringify(a)+'\\n');if(a[0]==='read')console.log(JSON.stringify({events:[{kind:'message',room:'r1',body:'x'},{kind:'message',room:'r1',body:'y'},{kind:'invite',room:'r2'}],cursor:3}));`);
    const realBunLocal = spawnSync('sh', ['-c', 'command -v bun'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(dir, 'bun'), `#!/bin/sh\nif [ "$1" = src/cli.ts ]; then shift; exec '${realBunLocal}' '${fake}' "$@"; fi\nexec '${realBunLocal}' "$@"\n`, { mode: 0o700 });
    const env = { ...process.env, PATH: dir + ':' + process.env.PATH, VORTEX_DIR: dir, VORTEX_UNREAD: '2', VORTEX_CODEX_HOST_PID: '2147483647' };
    const ring = () => spawnSync(resolve('skills/vortex/adapters/' + script), [], { env }).status;
    writeFileSync(join(dir, 'online-until'), String(Date.now() + 60000));
    assert.equal(ring(), 76);
    assert.equal(ring(), 76);
    const calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const sends = calls.filter((c) => c[0] === 'send');
    assert.equal(sends.length, 1);
    assert.equal(sends[0][2], 'r1');
    assert.match(sends[0][4], new RegExp(`^From ${owner}, automatic reply, not typed by the operator`));
    writeFileSync(join(dir, 'presence-epoch'), 'returned');
    assert.equal(ring(), 76);
    const reset = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(reset.filter((c) => c[0] === 'send').length, 2);
    assert.equal(calls.some((c) => c[0] === 'ack'), false);
    assert.throws(() => readFileSync(join(dir, 'agent-started')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude adapter: new topic gets --session-id and persists map', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vortex-claude-adapter-'));
  try {
    writeFileSync(join(dir, 'wake'), '');
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      cursor: 1, acked: 0, events: [{ cursor: 1, kind: 'message', room: 'r1', body: 'hi', peer: 'p', trust: 'untrusted_peer_content' }],
    }));
    const fakeCli = makeCli(dir);
    makeBun(dir, fakeCli);
    makeTimeout(dir, 0);
    const { status, args, map } = runAdapter(dir, { VORTEX_UNREAD: '1' });
    assert.equal(status, 0);
    assert.ok(args);
    const at = args.indexOf('claude');
    assert.equal(args[at + 1], '-p');
    const sessionFlagIdx = args.indexOf('--session-id');
    assert.notEqual(sessionFlagIdx, -1);
    const session = args[sessionFlagIdx + 1];
    assert.match(session, /^[0-9a-f-]{36}$/);
    assert.ok(map);
    const keys = Object.keys(map);
    assert.equal(keys.length, 1);
    assert.equal(keys[0], 'cursor:1');
    assert.equal(map['cursor:1'].session, session);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude adapter: same topic on next ring gets --resume with same UUID', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vortex-claude-adapter-'));
  const cdir = mkdtempSync(join(tmpdir(), 'vortex-claude-cfg-'));
  try {
    writeFileSync(join(dir, 'wake'), '');
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      cursor: 1, acked: 0, events: [{ cursor: 1, kind: 'message', room: 'r1', body: 'hi', peer: 'p', trust: 'untrusted_peer_content' }],
    }));
    mkdirSync(join(cdir, 'projects', 'proj'), { recursive: true });
    const fakeCli = makeCli(dir);
    makeBun(dir, fakeCli);
    makeTimeout(dir, 0);
    const first = runAdapter(dir, { VORTEX_UNREAD: '1', CLAUDE_CONFIG_DIR: cdir });
    assert.equal(first.status, 0);
    assert.ok(first.args);
    const uuid = first.args[first.args.indexOf('--session-id') + 1];
    // simulate claude creating the session file
    writeFileSync(join(cdir, 'projects', 'proj', uuid + '.jsonl'), '');
    makeTimeout(dir, 0);
    const second = runAdapter(dir, { VORTEX_UNREAD: '1', CLAUDE_CONFIG_DIR: cdir });
    assert.equal(second.status, 0);
    assert.ok(second.args);
    const resumeIdx = second.args.indexOf('--resume');
    assert.notEqual(resumeIdx, -1);
    assert.equal(second.args[resumeIdx + 1], uuid);
    assert.equal(second.map['cursor:1'].session, uuid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cdir, { recursive: true, force: true });
  }
});

test('Claude adapter: interleaved topics handles only first run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vortex-claude-adapter-'));
  try {
    writeFileSync(join(dir, 'wake'), '');
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      cursor: 3, acked: 0, events: [
        { cursor: 1, kind: 'conference_message', room: 'r1', body: 'a', peer: 'p', trust: 'untrusted_peer_content', conference: 'a'.repeat(32) },
        { cursor: 2, kind: 'conference_message', room: 'r2', body: 'b', peer: 'p', trust: 'untrusted_peer_content', conference: 'b'.repeat(32) },
        { cursor: 3, kind: 'conference_message', room: 'r3', body: 'a2', peer: 'p', trust: 'untrusted_peer_content', conference: 'a'.repeat(32) },
      ],
    }));
    const fakeCli = makeCli(dir);
    makeBun(dir, fakeCli);
    makeTimeout(dir, 0);
    const { status, args } = runAdapter(dir, { VORTEX_UNREAD: '3' });
    assert.equal(status, 0);
    assert.ok(args);
    const prompt = args[args.indexOf('-p') + 1];
    assert.match(prompt, /Topic key: conference:/);
    assert.match(prompt, /Process ONLY events with cursors from 1 through 1 \(inclusive\)/);
    assert.match(prompt, /ack --dir \S+ --cursor 1\. Ack 1, nothing later/);
    assert.doesNotMatch(prompt, /--room/);

    // Charged room (2026-10-23): a ring charged to r2 handles r2's run, not
    // the older r1 head, and reads and acks with that room's scope.
    const charged = runAdapter(dir, { VORTEX_UNREAD: '3', VORTEX_ROOM: 'r2' });
    assert.equal(charged.status, 0);
    const scoped = charged.args![charged.args!.indexOf('-p') + 1];
    assert.match(scoped, /Process ONLY events with cursors from 2 through 2 \(inclusive\)/);
    assert.match(scoped, /read --dir \S+ --room '<room>'/);
    assert.match(scoped, /ack --dir \S+ --cursor 2 --room '<room>', where <room> is exactly: r2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude adapter: conference event and routed DM share a session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vortex-claude-adapter-'));
  try {
    const conf = 'c'.repeat(32);
    writeFileSync(join(dir, 'wake'), '');
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      cursor: 2, acked: 0, events: [
        { cursor: 1, kind: 'conference_message', room: 'r1', body: 'a', peer: 'p', trust: 'untrusted_peer_content', conference: conf },
        { cursor: 2, kind: 'message', room: 'r2', body: 'b', peer: 'p', trust: 'untrusted_peer_content', routingConference: conf },
      ],
    }));
    const fakeCli = makeCli(dir);
    makeBun(dir, fakeCli);
    makeTimeout(dir, 0);
    const { status, args, map } = runAdapter(dir, { VORTEX_UNREAD: '2' });
    assert.equal(status, 0);
    assert.ok(args);
    const prompt = args[args.indexOf('-p') + 1];
    assert.match(prompt, /Process ONLY events with cursors from 1 through 2 \(inclusive\)/);
    const keys = Object.keys(map);
    assert.equal(keys.length, 1);
    assert.equal(keys[0], `conference:${conf}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude adapter: legacy direct message gets cursor: key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vortex-claude-adapter-'));
  try {
    writeFileSync(join(dir, 'wake'), '');
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      cursor: 1, acked: 0, events: [{ cursor: 7, kind: 'message', room: 'r1', body: 'hi', peer: 'p', trust: 'untrusted_peer_content' }],
    }));
    const fakeCli = makeCli(dir);
    makeBun(dir, fakeCli);
    makeTimeout(dir, 0);
    const { status, map } = runAdapter(dir, { VORTEX_UNREAD: '1' });
    assert.equal(status, 0);
    assert.ok(map);
    assert.ok(Object.prototype.hasOwnProperty.call(map, 'cursor:7'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude adapter: map exists before agent starts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vortex-claude-adapter-'));
  try {
    writeFileSync(join(dir, 'wake'), '');
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      cursor: 1, acked: 0, events: [{ cursor: 1, kind: 'message', room: 'r1', body: 'hi', peer: 'p', trust: 'untrusted_peer_content' }],
    }));
    const fakeCli = makeCli(dir);
    makeBun(dir, fakeCli);
    // fake agent checks the map exists before recording args
    makeTimeout(dir, 0, `if [ ! -f '${join(dir, 'claude-topics.json')}' ]; then echo missing > '${join(dir, 'mapmissing')}'; fi`);
    const { status } = runAdapter(dir, { VORTEX_UNREAD: '1' });
    assert.equal(status, 0);
    assert.equal(existsSync(join(dir, 'mapmissing')), false);
    assert.equal(existsSync(join(dir, 'claude-topics.json')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude adapter: no peer text appears in argv', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vortex-claude-adapter-'));
  try {
    writeFileSync(join(dir, 'wake'), '');
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      cursor: 1, acked: 0, events: [{ cursor: 1, kind: 'message', room: 'r1', body: 'PEER_BODY_MUST_NOT_BECOME_PROMPT', peer: 'p', trust: 'untrusted_peer_content' }],
    }));
    const fakeCli = makeCli(dir);
    makeBun(dir, fakeCli);
    makeTimeout(dir, 0);
    const { status, args } = runAdapter(dir, { VORTEX_UNREAD: '1' });
    assert.equal(status, 0);
    assert.ok(args);
    const joined = args.join('\u0000');
    assert.ok(!joined.includes('PEER_BODY_MUST_NOT_BECOME_PROMPT'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude adapter: corrupt map exits 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vortex-claude-adapter-'));
  try {
    writeFileSync(join(dir, 'wake'), '');
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      cursor: 1, acked: 0, events: [{ cursor: 1, kind: 'message', room: 'r1', body: 'hi', peer: 'p', trust: 'untrusted_peer_content' }],
    }));
    writeFileSync(join(dir, 'claude-topics.json'), '{not json');
    const fakeCli = makeCli(dir);
    makeBun(dir, fakeCli);
    makeTimeout(dir, 0);
    const { status, args } = runAdapter(dir, { VORTEX_UNREAD: '1' });
    assert.equal(status, 1);
    assert.equal(args, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude adapter: non-object map exits 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vortex-claude-adapter-'));
  try {
    writeFileSync(join(dir, 'wake'), '');
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      cursor: 1, acked: 0, events: [{ cursor: 1, kind: 'message', room: 'r1', body: 'hi', peer: 'p', trust: 'untrusted_peer_content' }],
    }));
    writeFileSync(join(dir, 'claude-topics.json'), '[]');
    const fakeCli = makeCli(dir);
    makeBun(dir, fakeCli);
    makeTimeout(dir, 0);
    const { status } = runAdapter(dir, { VORTEX_UNREAD: '1' });
    assert.equal(status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude adapter: invalid conference values fall back to cursor key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vortex-claude-adapter-'));
  try {
    writeFileSync(join(dir, 'wake'), '');
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      cursor: 1, acked: 0, events: [{ cursor: 1, kind: 'message', room: 'r1', body: 'hi', peer: 'p', trust: 'untrusted_peer_content', conference: 'not-a-valid-id' }],
    }));
    const fakeCli = makeCli(dir);
    makeBun(dir, fakeCli);
    makeTimeout(dir, 0);
    const { status, map } = runAdapter(dir, { VORTEX_UNREAD: '1' });
    assert.equal(status, 0);
    assert.ok(map);
    assert.ok(Object.prototype.hasOwnProperty.call(map, 'cursor:1'));
    assert.ok(!Object.keys(map).some((k) => k.startsWith('conference:')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude adapter: session existence drives new flag (first ring)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vortex-claude-adapter-'));
  const cdir = mkdtempSync(join(tmpdir(), 'vortex-claude-cfg-'));
  try {
    writeFileSync(join(dir, 'wake'), '');
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      cursor: 1, acked: 0, events: [{ cursor: 1, kind: 'message', room: 'r1', body: 'hi', peer: 'p', trust: 'untrusted_peer_content' }],
    }));
    mkdirSync(join(cdir, 'projects'), { recursive: true });
    const fakeCli = makeCli(dir);
    makeBun(dir, fakeCli);
    makeTimeout(dir, 0);
    const { status, args } = runAdapter(dir, { VORTEX_UNREAD: '1', CLAUDE_CONFIG_DIR: cdir });
    assert.equal(status, 0);
    assert.ok(args);
    assert.notEqual(args.indexOf('--session-id'), -1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cdir, { recursive: true, force: true });
  }
});

test('Claude adapter: session exists -> resume same UUID', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vortex-claude-adapter-'));
  const cdir = mkdtempSync(join(tmpdir(), 'vortex-claude-cfg-'));
  try {
    writeFileSync(join(dir, 'wake'), '');
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      cursor: 1, acked: 0, events: [{ cursor: 1, kind: 'message', room: 'r1', body: 'hi', peer: 'p', trust: 'untrusted_peer_content' }],
    }));
    mkdirSync(join(cdir, 'projects', 'proj'), { recursive: true });
    const fakeCli = makeCli(dir);
    makeBun(dir, fakeCli);
    makeTimeout(dir, 0);
    const first = runAdapter(dir, { VORTEX_UNREAD: '1', CLAUDE_CONFIG_DIR: cdir });
    assert.equal(first.status, 0);
    assert.ok(first.args);
    const uuid = first.args[first.args.indexOf('--session-id') + 1];
    // create the jsonl file so the session is considered to exist
    writeFileSync(join(cdir, 'projects', 'proj', uuid + '.jsonl'), '');
    makeTimeout(dir, 0);
    const second = runAdapter(dir, { VORTEX_UNREAD: '1', CLAUDE_CONFIG_DIR: cdir });
    assert.equal(second.status, 0);
    assert.ok(second.args);
    assert.notEqual(second.args.indexOf('--resume'), -1);
    assert.equal(second.args[second.args.indexOf('--resume') + 1], uuid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cdir, { recursive: true, force: true });
  }
});

test('Claude adapter: missing jsonl keeps new:true with same UUID', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vortex-claude-adapter-'));
  const cdir = mkdtempSync(join(tmpdir(), 'vortex-claude-cfg-'));
  try {
    writeFileSync(join(dir, 'wake'), '');
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      cursor: 1, acked: 0, events: [{ cursor: 1, kind: 'message', room: 'r1', body: 'hi', peer: 'p', trust: 'untrusted_peer_content' }],
    }));
    mkdirSync(join(cdir, 'projects'), { recursive: true });
    const fakeCli = makeCli(dir);
    makeBun(dir, fakeCli);
    makeTimeout(dir, 0);
    const first = runAdapter(dir, { VORTEX_UNREAD: '1', CLAUDE_CONFIG_DIR: cdir });
    assert.equal(first.status, 0);
    assert.ok(first.args);
    const uuid = first.args[first.args.indexOf('--session-id') + 1];
    // do not create jsonl
    makeTimeout(dir, 0);
    const second = runAdapter(dir, { VORTEX_UNREAD: '1', CLAUDE_CONFIG_DIR: cdir });
    assert.equal(second.status, 0);
    assert.ok(second.args);
    assert.notEqual(second.args.indexOf('--session-id'), -1);
    assert.equal(second.args[second.args.indexOf('--session-id') + 1], uuid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cdir, { recursive: true, force: true });
  }
});
