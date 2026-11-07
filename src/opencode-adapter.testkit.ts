// Docs: VORTEX_v5.1.md §9.3; skills/vortex/SKILL.md — Being woken when idle; ISSUES.md I6/I10.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';


export const WRAPPER = resolve('skills/vortex/adapters/opencode.sh');
export const ADAPTER = resolve('skills/vortex/adapters/opencode.mjs');
export const SESSION = 'ses_testfixture000000000001';
export const CREATED = 'ses_createdbyadapter0000001';
export const TRUSTED = '12D3KooWTestFixturePeerXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
export const PEER_MARKER = 'PEER_BODY_MUST_NOT_BECOME_PROMPT';

export interface LoggedRequest { method: string; url: string; body: unknown; auth?: string }
export const PASSWORD = 'fixture-password';
export const BASIC = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;

export async function startFixture(acked: number, opts: {
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

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const promptTarget = async (f: Awaited<ReturnType<typeof startFixture>>) => {
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

export const CONF_A = 'a'.repeat(32);
export const CONF_B = 'b'.repeat(32);

export const awaitPrompt = async (f: Awaited<ReturnType<typeof startFixture>>, child: ReturnType<typeof spawn>) => {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const post = f.requests.find((r) => r.method === 'POST' && r.url.includes('/prompt'));
    if (post) return (post.body as { text: string }).text;
    if (child.exitCode != null) throw new Error('adapter exited before dispatch');
    await sleep(25);
  }
  throw new Error('expected one async prompt');
};
