// @bun
// v6/plugins/opencode/ready.ts
import { readFileSync as readFileSync2 } from "fs";

// v6/client/credential.ts
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
function vortexConfigDir() {
  const xdg = process.env.XDG_CONFIG_HOME ?? `${process.env.HOME ?? "/root"}/.config`;
  return `${xdg.replace(/\/$/, "")}/vortex`;
}
function credentialPath(name) {
  return `${vortexConfigDir()}/${name}.json`;
}
function loadCredential(name) {
  const path = credentialPath(name);
  if (!existsSync(path))
    return;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed.hub !== "string" || typeof parsed.token !== "string") {
    throw new Error(`invalid credential file: ${path}`);
  }
  return parsed;
}

// v6/client/client.ts
function derDigest(raw) {
  const h = new Bun.CryptoHasher("sha256");
  h.update(raw);
  return h.digest("hex");
}
async function pinnedTls(hub, fingerprint) {
  const pin = fingerprint.toLowerCase().replace(/:/g, "");
  const url = new URL(hub.replace(/^ws/, "http"));
  const port = Number(url.port || 443);
  const { connect } = await import("tls");
  const raw = await new Promise((resolve, reject) => {
    const sock = connect({ host: url.hostname, port, rejectUnauthorized: false }, () => {
      const der = sock.getPeerCertificate(true)?.raw;
      sock.destroy();
      if (der === undefined)
        reject(new Error("vortex: hub presented no TLS certificate"));
      else
        resolve(new Uint8Array(der));
    });
    sock.setTimeout(1e4, () => {
      sock.destroy();
      reject(new Error("vortex: TLS probe timed out"));
    });
    sock.on("error", reject);
  });
  if (derDigest(raw) !== pin)
    throw new Error("vortex: TLS fingerprint pin mismatch");
  const b64 = Buffer.from(raw).toString("base64").match(/.{1,64}/g).join(`
`);
  return {
    ca: `-----BEGIN CERTIFICATE-----
${b64}
-----END CERTIFICATE-----
`,
    checkServerIdentity: (_host, cert) => derDigest(new Uint8Array(cert.raw)) === pin ? undefined : new Error("vortex: TLS fingerprint pin mismatch")
  };
}

class VortexClient {
  cfg;
  tlsOptions;
  timeoutMs;
  constructor(cfg, opts = {}) {
    this.cfg = cfg;
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }
  async pin() {
    if (this.cfg.fingerprint === undefined || this.tlsOptions !== undefined)
      return;
    this.tlsOptions = await pinnedTls(this.cfg.hub, this.cfg.fingerprint);
  }
  httpBase() {
    return this.cfg.hub.replace(/^ws/, "http");
  }
  async req(method, path, body) {
    await this.pin();
    const tls = this.tlsOptions;
    return fetch(`${this.httpBase()}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.cfg.token}`,
        "content-type": "application/json"
      },
      ...body === undefined ? {} : { body: JSON.stringify(body) },
      ...tls === undefined ? {} : { tls },
      signal: AbortSignal.timeout(this.timeoutMs)
    });
  }
  async send(msg) {
    const res = await this.req("POST", "/v1/messages", msg);
    return await expectJson(res, 200);
  }
  async bind(binding, rooms) {
    const res = await this.req("PUT", `/v1/bindings/${encodeURIComponent(binding)}`, { rooms });
    return await expectJson(res, 200);
  }
  async status() {
    return await expectJson(await this.req("GET", "/v1/status"), 200);
  }
  async roomLog(room, after = 0, limit = 100) {
    return await expectJson(await this.req("GET", `/v1/rooms/${encodeURIComponent(room)}/log?after=${after}&limit=${limit}`), 200);
  }
  async dmLog(after = 0, limit = 100) {
    return await expectJson(await this.req("GET", `/v1/dms?after=${after}&limit=${limit}`), 200);
  }
  async ownDmLog(after = 0, limit = 100) {
    return await expectJson(await this.req("GET", `/v1/dms/mine?after=${after}&limit=${limit}`), 200);
  }
  async recent(limit = 200) {
    return await expectJson(await this.req("GET", `/v1/recent?limit=${limit}`), 200);
  }
  async release(principal, name) {
    return await expectJson(await this.req("DELETE", `/v1/bindings/${encodeURIComponent(principal)}/${encodeURIComponent(name)}`), 200);
  }
  stream(binding, handlers) {
    if (this.cfg.fingerprint !== undefined && this.tlsOptions === undefined) {
      throw new Error("vortex: pinned hub requires `await client.pin()` before stream()");
    }
    const tls = this.tlsOptions;
    const headers = { authorization: `Bearer ${this.cfg.token}` };
    const url = `${this.cfg.hub}/v1/bindings/${encodeURIComponent(binding)}/stream`;
    const ws = new WebSocket(url, {
      headers,
      ...tls === undefined ? {} : { tls }
    });
    ws.addEventListener("open", () => handlers.onOpen?.());
    ws.addEventListener("message", (event) => {
      let frame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (frame.type === "batch")
        handlers.onBatch(frame.batch, frame.wake, frame.messages, frame.notices ?? []);
      else if (frame.type === "empty")
        handlers.onEmpty?.();
      else if (frame.type === "error") {
        if (handlers.onError !== undefined)
          handlers.onError(frame.reason, frame.batch);
      }
    });
    ws.addEventListener("close", (event) => handlers.onClose?.({ code: event.code, reason: event.reason }));
    ws.addEventListener("error", () => {});
    return { ws };
  }
  delivered(ws, batch, evidence) {
    ws.send(JSON.stringify({ type: "delivered", batch, evidence }));
  }
  failed(ws, batch, reason) {
    ws.send(JSON.stringify({ type: "failed", batch, reason }));
  }
  fault(ws, reason) {
    ws.send(JSON.stringify({ type: "fault", reason }));
  }
  pull(ws) {
    ws.send(JSON.stringify({ type: "pull", kind: "passive" }));
  }
}
async function expectJson(res, status) {
  const payload = await res.json().catch(() => {
    return;
  });
  if (res.status !== status) {
    const detail = payload?.error ?? res.statusText;
    const err = new Error(`vortex hub ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return payload;
}

// v6/plugins/opencode/ready.ts
var EXIT = { ready: 0, "never-bound": 3, offline: 4, "opencode-unreachable": 5 };
var defaultDeps = { fetch: (input, init) => fetch(input, init), now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
function hubLabel(hub) {
  return hub.replace(/\/+$/, "");
}
async function activate(o, d) {
  const headers = {};
  if (o.password !== undefined && o.password.length > 0)
    headers.authorization = `Basic ${btoa(`opencode:${o.password}`)}`;
  try {
    const res = await d.fetch(`${o.server.replace(/\/+$/, "")}/api/config?directory=${encodeURIComponent(o.directory)}`, { headers, signal: AbortSignal.timeout(1e4) });
    return res.ok;
  } catch {
    return false;
  }
}
async function bindingStatus(o, client) {
  try {
    const body = await Promise.race([
      client.status(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("status timeout")), 1e4))
    ]);
    const principal = o.credential.principal ?? "opencode";
    return (body.bindings ?? []).find((b) => b.principal === principal && b.name === o.binding);
  } catch {
    return "hub-error";
  }
}
async function checkReady(o, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  if (!Number.isFinite(o.timeoutMs) || o.timeoutMs < 1 || o.timeoutMs > MAX_TIMEOUT_MS)
    throw new RangeError(`timeoutMs must be finite within 1..${MAX_TIMEOUT_MS}`);
  const deadline = d.now() + o.timeoutMs;
  const poll = o.pollMs ?? 1000;
  let activated = false;
  let last = undefined;
  const client = new VortexClient(o.credential);
  while (true) {
    if (!activated)
      activated = await activate(o, d);
    if (activated) {
      last = await bindingStatus(o, client);
      if (last !== undefined && last !== "hub-error" && last.open) {
        return { state: "ready", detail: `binding ${last.principal}/${last.name} stream open`, pending: norm(last.pending), lastError: last.lastError };
      }
    }
    if (d.now() + poll > deadline)
      break;
    await d.sleep(poll);
  }
  if (!activated)
    return { state: "opencode-unreachable", detail: `OpenCode at ${o.server} did not answer a directory-scoped request for ${o.directory}` };
  if (last === "hub-error")
    return { state: "offline", detail: `hub ${hubLabel(o.credential.hub)} status unavailable (unreachable, unauthorized or TLS pin mismatch); cannot confirm the stream` };
  if (last === undefined) {
    return { state: "never-bound", detail: `no binding ${o.credential.principal ?? "opencode"}/${o.binding} on the hub: fresh setup, or the plugin is inactive for ${o.directory} (check options.directory, acceptRevisions, credential; OpenCode logs "[vortex] inactive: ...")` };
  }
  const pending = norm(last.pending);
  return { state: "offline", detail: `binding ${last.principal}/${last.name} retained but stream not open; mail queues on the hub (wake ${pending.wake}, passive ${pending.passive})`, pending, lastError: last.lastError };
}
function norm(p) {
  return { wake: p?.wake ?? 0, passive: p?.passive ?? 0 };
}
function parse(argv) {
  const m = new Map;
  for (let i = 0;i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && argv[i + 1] !== undefined) {
      m.set(a.slice(2), argv[i + 1]);
      i++;
    }
  }
  return m;
}
var MAX_TIMEOUT_MS = 3600000;
function parseTimeout(raw) {
  if (raw === undefined)
    return 60000;
  if (!/^[0-9]+$/.test(raw.trim()))
    return `--timeout-ms must be a whole number of milliseconds (1..${MAX_TIMEOUT_MS}), got "${raw}"`;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_TIMEOUT_MS)
    return `--timeout-ms must be within 1..${MAX_TIMEOUT_MS}, got ${raw}`;
  return n;
}
async function main(argv) {
  const f = parse(argv);
  const timeoutMs = parseTimeout(f.get("timeout-ms"));
  if (typeof timeoutMs === "string") {
    console.error(`vortex-ready: ${timeoutMs}`);
    return 2;
  }
  const directory = f.get("directory");
  if (directory === undefined || !directory.startsWith("/")) {
    console.error("vortex-ready: --directory <absolute wake Location> is required");
    return 2;
  }
  let credential;
  try {
    const file = f.get("credential");
    credential = file !== undefined ? JSON.parse(readFileSync2(file, "utf8")) : loadCredential("opencode");
  } catch (e) {
    console.error(`vortex-ready: credential unreadable: ${e.message}`);
    return 2;
  }
  if (credential === undefined || typeof credential.hub !== "string" || typeof credential.token !== "string") {
    console.error("vortex-ready: no opencode credential (run: vx enroll opencode, or pass --credential)");
    return 2;
  }
  const r = await checkReady({
    server: f.get("server") ?? "http://127.0.0.1:4096",
    directory: directory.replace(/\/+$/, "") || "/",
    binding: f.get("binding") ?? "opencode",
    credential,
    timeoutMs,
    password: process.env.OPENCODE_SERVER_PASSWORD
  });
  const line = `vortex-ready: ${r.state}: ${r.detail}${r.lastError ? ` (lastError: ${r.lastError})` : ""}`;
  if (r.state === "ready")
    console.log(line);
  else
    console.error(line);
  return EXIT[r.state];
}
if (import.meta.main)
  process.exit(await main(process.argv.slice(2)));
export {
  EXIT,
  MAX_TIMEOUT_MS,
  checkReady,
  main,
  parseTimeout
};
