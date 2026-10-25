import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, chmodSync, existsSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Docs: VORTEX_v5.1.md §9.3 (event delivery/wake); Docs: ISSUES.md I10 (OpenCode harness repair), I8 (OTP wake backbone).
// Docs: README.md — Keep Codex's service running between sessions (info.wake fields).
// Docs: docs/2026-10-22-presence-design.md — routing an unread event by presence.

const concise = (value: unknown): string => JSON.stringify(value).slice(0, 200);

const waitFor = async (check: () => boolean | Promise<boolean>, label: string, ms = 15000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`deadline: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const startRouter = async (processes: ChildProcess[], socket: string) => {
  const build = spawnSync('mix', ['escript.build'], { cwd: resolve('backbone'), encoding: 'utf8' });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const router = spawn(resolve('backbone/vortex_router'), ['--socket', socket, '--min-interval-ms', '0'], { stdio: 'ignore' });
  processes.push(router);
  await waitFor(() => existsSync(socket), 'OTP router did not start', 8000);
};

const startService = async (
  processes: ChildProcess[], routerSocket: string, name: string, dir: string,
  extraArgs: string[] = [], extraEnv: Record<string, string> = {},
) => {
  if (existsSync(join(dir, 'endpoint.json'))) unlinkSync(join(dir, 'endpoint.json'));
  const child = spawn('bun', ['src/cli.ts', 'serve', '--dir', dir, '--name', name, '--port', '0',
    '--ring-quiet-ms', '0', '--backbone', routerSocket, ...extraArgs], {
    stdio: 'ignore', env: { ...process.env, ...extraEnv },
  });
  processes.push(child);
  const end = Date.now() + 8000;
  while (!existsSync(join(dir, 'endpoint.json'))) {
    if (child.exitCode !== null || Date.now() > end) throw new Error(`test service ${name} did not start`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const endpoint = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8'));
  const call = async (op: string, args: unknown = {}) => {
    const response = await fetch(endpoint.url + '/' + op, { method: 'POST',
      headers: { authorization: 'Bearer ' + endpoint.token, 'content-type': 'application/json' },
      body: JSON.stringify(args) });
    const result = await response.json() as any;
    if (!response.ok) throw new Error(`${op} failed: ${concise(result)}`);
    return result;
  };
  return { dir, child, call, endpoint };
};

// End-to-end wake regression: storage -> OTP router -> real opencode.sh adapter ->
// loopback host -> real read/ack. Proves delivery by ack, not transport write.
test('stored mail rings the real adapter and is read and acked via the loopback host', { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'vortex-opencode-wake-'));
  const processes: ChildProcess[] = [];
  const routerSocket = join(root, 'router.sock');
  const projectDir = join(root, 'proj');
  const recvDir = join(projectDir, '.vortex', 'opencode');
  const adapter = resolve('skills/vortex/adapters/opencode.sh');
  const SESSION = 'ses_wakee2efixture00000001';
  const MARKER_ONE = 'wake-e2e-marker-one-7f3a';
  const MARKER_TWO = 'wake-e2e-marker-two-9c1e';
  let server: Server | undefined;
  try {
    await startRouter(processes, routerSocket);

    // Fake OpenCode loopback host: pinned session, controllable busy/idle, no model calls.
    let mode: 'busy' | 'idle' = 'busy';
    let busyPolls = 0;
    const prompts: Array<{ url: string, body: any }> = [];
    const pages: Array<{ marker: string, events: any[], cursor: number }> = [];
    let receiverEndpoint: { url: string, token: string } | undefined;
    const sessionDoc = { id: SESSION, projectID: 'proj', location: { directory: projectDir },
      title: 'wake', time: { created: 1, updated: 2 }, agent: 'build',
      model: { id: 'muse-spark-1.3-contributor-free', providerID: 'opencode', variant: 'default' } };
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const u = new URL(req.url ?? '/', 'http://x');
        const json = (code: number, value: unknown) => {
          if (res.destroyed) return;
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(value));
        };
        if (req.method === 'GET' && u.pathname === `/api/session/${SESSION}`) json(200, { data: sessionDoc });
        else if (req.method === 'GET' && u.pathname === '/api/model/default')
          json(200, { location: { directory: projectDir }, data: { providerID: 'opencode', id: 'muse-spark-1.3-contributor-free' } });
        else if (req.method === 'GET' && u.pathname === '/api/session/active') {
          if (mode === 'busy') busyPolls++;
          json(200, { data: mode === 'busy' ? { [SESSION]: { type: 'running' } } : {} });
        }
        else if (req.method === 'GET' && u.pathname.endsWith('/form')) json(200, { data: [] });
        else if (req.method === 'GET' && u.pathname.endsWith('/permission')) json(200, { data: [] });
        else if (req.method === 'POST' && u.pathname === `/api/session/${SESSION}/prompt`) {
          prompts.push({ url: req.url ?? '', body: raw ? JSON.parse(raw) : undefined });
          json(200, { data: { id: 'msg_1', type: 'user', delivery: 'queue' } });
          // Simulated model turn: read the receiver's own temp inbox and ack it.
          setImmediate(() => {
            (async () => {
              if (!receiverEndpoint) return;
              const read = await (await fetch(receiverEndpoint.url + '/read', { method: 'POST',
                headers: { authorization: 'Bearer ' + receiverEndpoint.token, 'content-type': 'application/json' },
                body: '{}' })).json() as any;
              const bodies = (read.events ?? []).map((e: any) => String(e.body ?? ''));
              for (const marker of [MARKER_ONE, MARKER_TWO]) {
                if (bodies.some((b: string) => b.includes(marker))) pages.push({ marker, events: read.events, cursor: read.cursor });
              }
              await fetch(receiverEndpoint.url + '/ack', { method: 'POST',
                headers: { authorization: 'Bearer ' + receiverEndpoint.token, 'content-type': 'application/json' },
                body: JSON.stringify({ cursor: read.cursor }) });
            })().catch(() => {});
          });
        }
        else { res.writeHead(404); res.end('{}'); }
      });
    });
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
    const hostPort = (server.address() as { port: number }).port;

    // Handshake first with no adapter live, so only test mail can ring.
    const sendDir = join(root, 'sender');
    const sender = await startService(processes, routerSocket, 'sender', sendDir);
    let receiver = await startService(processes, routerSocket, 'receiver', recvDir);
    const senderInfo = await sender.call('info');
    await sender.call('dial', { peer: (await receiver.call('info')).addrs[0] });
    const { room } = await sender.call('invite', { peer: (await receiver.call('info')).peerId });
    await receiver.call('wait', { timeout: 3 });
    await receiver.call('accept', { room });
    const accepted = await sender.call('wait', { timeout: 3 });
    await sender.call('ack', { cursor: accepted.cursor });
    const racke = await receiver.call('read');
    await receiver.call('ack', { cursor: racke.cursor });
    receiver.child.kill('SIGTERM');
    await new Promise<void>((resolve) => receiver.child.once('exit', () => resolve()));

    // Restart the receiver on the same temp state with the real adapter live.
    receiver = await startService(processes, routerSocket, 'receiver', recvDir, ['--on-ring', adapter], {
      VORTEX_OPENCODE_URL: `http://127.0.0.1:${hostPort}`,
      VORTEX_OPENCODE_SESSION: SESSION,
      VORTEX_TRUSTED_PEERS: `codex=${senderInfo.peerId}`,
      VORTEX_ADAPTER_DEADLINE_MS: '15000',
      VORTEX_ADAPTER_POLL_MS: '50',
    });
    receiverEndpoint = receiver.endpoint;
    await sender.call('dial', { peer: (await receiver.call('info')).addrs[0] });
    await waitFor(async () => (await receiver.call('info')).wake.routerConnected, 'receiver registered with router');
    const info = await receiver.call('info');
    assert.match(info.peerId, /^[1-9A-HJ-NP-Za-km-z]+$/, 'transport peerId retained');
    assert.ok(Array.isArray(info.addrs) && info.addrs.length > 0, 'transport addrs retained');
    assert.deepEqual(info.wake, { configured: true, adapter, rings: true, refusedRings: 0, routerConnected: true, adapterRunning: false, lastExitCode: null });
    const senderWake = (await sender.call('info')).wake;
    assert.deepEqual(senderWake, { configured: false, adapter: null, rings: false, refusedRings: 0, routerConnected: false, adapterRunning: false, lastExitCode: null });

    // Message one arrives while the host is busy: no prompt until idle.
    await sender.call('send', { room, text: `first ${MARKER_ONE}` });
    await waitFor(() => busyPolls >= 2, 'adapter repeatedly observes the busy host');
    assert.equal(prompts.length, 0, 'no prompt while the host is busy');
    mode = 'idle';
    await waitFor(() => prompts.length === 1, 'exactly one model prompt after idle');
    assert.equal(prompts.length, 1);
    const promptText = prompts[0].body.text;
    assert.match(promptText, /Automated VORTEX ring notice/);
    assert.match(promptText, /not typed by the operator/);
    assert.ok(!promptText.includes(MARKER_ONE), 'peer body must not become prompt');
    await waitFor(() => pages.some((p) => p.marker === MARKER_ONE), 'stored mail read contains the marker');
    await waitFor(() => (JSON.parse(readFileSync(join(recvDir, 'state.json'), 'utf8')).acked ?? 0) >= pages.find((p) => p.marker === MARKER_ONE)!.cursor,
      'receiver acked message one');
    await waitFor(async () => (await receiver.call('info')).wake.lastExitCode === 0, 'adapter exit 0 recorded');
    assert.equal((await receiver.call('info')).wake.adapterRunning, false);

    // Message two proves repeatability through the same chain.
    await sender.call('send', { room, text: `second ${MARKER_TWO}` });
    await waitFor(() => prompts.length === 2, 'second wake prompts again');
    await waitFor(() => pages.some((p) => p.marker === MARKER_TWO), 'second stored mail read');
    await waitFor(() => (JSON.parse(readFileSync(join(recvDir, 'state.json'), 'utf8')).acked ?? 0) >= pages.find((p) => p.marker === MARKER_TWO)!.cursor,
      'receiver acked message two');
    assert.ok(!prompts[1].body.text.includes(MARKER_TWO));
  } finally {
    await Promise.all(processes.filter((p) => p.exitCode === null && p.signalCode === null)
      .map((p) => new Promise<void>((resolve) => { p.once('exit', () => resolve()); p.kill('SIGTERM'); })));
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

// Docs: docs/2026-10-22-presence-design.md — the routing table and edge case P5.
// OpenCode registers no host, so its mail rings unless a session line is open.
test('OpenCode mail rings only when no line is open', { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'vortex-opencode-routing-'));
  const processes: ChildProcess[] = [];
  const routerSocket = join(root, 'router.sock');
  const projectDir = join(root, 'proj');
  const recvDir = join(projectDir, '.vortex', 'opencode');
  const sendDir = join(root, 'sender');
  const ringsFile = join(recvDir, 'rings.log');
  let line: AbortController | undefined;
  const rings = () => {
    try { return readFileSync(ringsFile, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
  };
  const headers = (endpoint: { token: string }) => ({
    authorization: 'Bearer ' + endpoint.token, 'content-type': 'application/json',
  });
  try {
    await startRouter(processes, routerSocket);

    const stubScript = join(root, 'stub-adapter.mjs');
    writeFileSync(stubScript, [
      "import { appendFileSync, readFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const dir = process.env.VORTEX_DIR;",
      "const endpoint = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8'));",
      "const headers = { authorization: 'Bearer ' + endpoint.token, 'content-type': 'application/json' };",
      "const page = await (await fetch(endpoint.url + '/read', { method: 'POST', headers, body: '{}' })).json();",
      "await fetch(endpoint.url + '/ack', { method: 'POST', headers, body: JSON.stringify({ cursor: page.cursor }) });",
      "appendFileSync(join(dir, 'rings.log'), 'ring\\n');",
    ].join('\n'));
    const stub = join(root, 'stub-adapter.sh');
    writeFileSync(stub, `#!/bin/sh\nexec bun ${JSON.stringify(stubScript)}\n`);
    chmodSync(stub, 0o755);

    // Mutual consent first, with no adapter live so only later mail can ring.
    const sender = await startService(processes, routerSocket, 'sender', sendDir);
    let receiver = await startService(processes, routerSocket, 'receiver', recvDir);
    await sender.call('dial', { peer: (await receiver.call('info')).addrs[0] });
    const { room } = await sender.call('invite', { peer: (await receiver.call('info')).peerId });
    await receiver.call('wait', { timeout: 3 });
    await receiver.call('accept', { room });
    const accepted = await sender.call('wait', { timeout: 3 });
    await sender.call('ack', { cursor: accepted.cursor });
    const handshake = await receiver.call('read');
    await receiver.call('ack', { cursor: handshake.cursor });
    receiver.child.kill('SIGTERM');
    await new Promise<void>((resolve) => receiver.child.once('exit', () => resolve()));

    receiver = await startService(processes, routerSocket, 'receiver', recvDir, ['--on-ring', stub]);
    await sender.call('dial', { peer: (await receiver.call('info')).addrs[0] });
    await waitFor(async () => (await receiver.call('info')).wake.routerConnected, 'receiver registered with router');

    const info = await receiver.call('info');
    assert.equal(typeof info.presence?.lines, 'number', 'service presence API is required');

    const probe = await fetch(receiver.endpoint.url + '/attach', { method: 'POST', headers: headers(receiver.endpoint), body: '{}' });
    await probe.body?.cancel().catch(() => {});
    assert.equal(probe.status, 200, `attach refused with ${probe.status}`);

    // No line and no host: stored mail rings the owner's adapter.
    await sender.call('send', { room, text: 'routing-without-line' });
    await waitFor(() => rings() === 1, 'no line open: stored mail rings the adapter');

    // A line is open: the mail goes down the line and does not ring.
    line = new AbortController();
    const held = await fetch(receiver.endpoint.url + '/attach', { method: 'POST',
      headers: headers(receiver.endpoint), body: '{}', signal: line.signal });
    assert.equal(held.status, 200, `held attach refused with ${held.status}`);
    const reader = held.body!.getReader();
    await reader.read();
    await waitFor(async () => (await receiver.call('info')).presence.lines >= 1, 'open line counted as presence');
    await sender.call('send', { room, text: 'routing-with-line' });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(rings(), 1, 'an open line must not ring');

    // Closing the line detaches the session, so the held mail rings.
    line.abort();
    await reader.cancel().catch(() => {});
    await sender.call('send', { room, text: 'routing-after-line-closed' });
    await waitFor(() => rings() >= 2, 'closing the line lets mail ring');

    // An outstanding wait counts as an open line.
    const waitResponse = fetch(receiver.endpoint.url + '/wait', { method: 'POST',
      headers: headers(receiver.endpoint), body: JSON.stringify({ timeout: 30 }) });
    await waitFor(async () => (await receiver.call('info')).presence.lines >= 1, 'outstanding wait counts as a line');
    await receiver.call('nudge');
    await (await waitResponse).json().catch(() => undefined);
  } finally {
    line?.abort();
    await Promise.all(processes.filter((p) => p.exitCode === null && p.signalCode === null)
      .map((p) => new Promise<void>((resolve) => { p.once('exit', () => resolve()); p.kill('SIGTERM'); })));
    rmSync(root, { recursive: true, force: true });
  }
});

// Docs: VORTEX_v5.1.md §9.3; ISSUES.md I10 (quiet owner contrast).
test('quiet owner (no adapter) is never rung while an adapter owner is, both storing mail', { timeout: 90000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'vortex-quiet-owner-'));
  const processes: ChildProcess[] = [];
  const routerSocket = join(root, 'router.sock');
  const adapterLog = join(root, 'adapter-rings.log');
  const stubAdapter = join(root, 'stub-adapter.sh');
  writeFileSync(stubAdapter, `#!/bin/sh\nprintf 'ring\\n' >> '${adapterLog}'\nsleep 1\n`, { mode: 0o700 });
  const sendDir = join(root, 'sender');
  const quietDir = join(root, 'quiet');
  const adapterDir = join(root, 'adapterrecv');
  const QMARKER = 'quiet-owner-mail-q';
  const AMARKER = 'adapter-owner-mail-a';
  let server: Server | undefined;
  try {
    await startRouter(processes, routerSocket);
    const sender = await startService(processes, routerSocket, 'sender', sendDir);
    const quiet = await startService(processes, routerSocket, 'quiet', quietDir, ['--semantic']);
    const adapterRecv = await startService(processes, routerSocket, 'adapterrecv', adapterDir, ['--semantic', '--on-ring', stubAdapter]);
    const senderInfo = await sender.call('info');
    const quietInfo = await quiet.call('info');
    const adapterInfo = await adapterRecv.call('info');
    assert.equal(quietInfo.wake.adapter, null);
    assert.equal(quietInfo.wake.rings, false);
    assert.equal(quietInfo.wake.routerConnected, true);
    assert.equal(adapterInfo.wake.rings, true);

    // consent: sender <-> quiet
    await sender.call('dial', { peer: quietInfo.addrs[0] });
    const { room: qroom } = await sender.call('invite', { peer: quietInfo.peerId });
    await quiet.call('wait', { timeout: 2 });
    await quiet.call('accept', { room: qroom });
    const qacc = await sender.call('wait', { timeout: 2 });
    await sender.call('ack', { cursor: qacc.cursor });
    const qread0 = await quiet.call('read');
    await quiet.call('ack', { cursor: qread0.cursor });

    // consent: sender <-> adapterrecv
    await sender.call('dial', { peer: adapterInfo.addrs[0] });
    const { room: aroom } = await sender.call('invite', { peer: adapterInfo.peerId });
    await adapterRecv.call('wait', { timeout: 2 });
    await adapterRecv.call('accept', { room: aroom });
    const aacc = await sender.call('wait', { timeout: 2 });
    await sender.call('ack', { cursor: aacc.cursor });
    const aread0 = await adapterRecv.call('read');
    await adapterRecv.call('ack', { cursor: aread0.cursor });

    // deliver mail to both
    await sender.call('send', { room: qroom, text: QMARKER });
    await sender.call('send', { room: aroom, text: AMARKER });

    // adapter receiver gets rung (marker file appears) -- this is the window in
    // which a buggy quiet owner would also be rung and refused.
    await waitFor(() => existsSync(adapterLog) && readFileSync(adapterLog, 'utf8').trim().split('\n').filter(Boolean).length >= 1, 'adapter rung', 15000);
    // give the router one more cycle to (wrongly) ring the quiet owner
    await new Promise((resolve) => setTimeout(resolve, 200));

    // quiet receiver stores mail and was never rung (no refused rings)
    await waitFor(async () => (await quiet.call('read')).events.some((e: any) => String(e.body).includes(QMARKER)), 'quiet mail stored', 8000);
    const qinfo2 = await quiet.call('info');
    assert.equal(qinfo2.wake.refusedRings, 0, 'quiet owner never rung/refused');
    assert.equal(qinfo2.wake.lastExitCode, null, 'quiet owner never rung');
    // quiet has no adapter log of its own (none created)
    assert.ok(!existsSync(join(quietDir, 'rings.log')), 'quiet has no ring log');
  } finally {
    if (server) server.close();
    await Promise.all(processes.filter(p => p.exitCode === null && p.signalCode === null).map(p => new Promise<void>(resolve => { p.once('exit', () => resolve()); p.kill('SIGTERM'); })));
    rmSync(root, { recursive: true, force: true });
  }
});
