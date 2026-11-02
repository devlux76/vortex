// @bun
// v6/cli/vx.ts
import { mkdirSync as mkdirSync4, existsSync as existsSync3 } from "fs";

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
  constructor(cfg) {
    this.cfg = cfg;
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
      ...tls === undefined ? {} : { tls }
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

// v6/client/render.ts
var DEFAULT_BOUNDS = { maxMessages: 20, maxCodePoints: 6000, maxBytes: 8 * 1024 };
var enc = new TextEncoder;
function normalizeBody(text) {
  return text.replace(/\r\n|\r|[\u0085\u2028\u2029]/g, `
`);
}
function headerLabel(m) {
  return m.from === "operator" ? "operator (human)" : m.from;
}
function listingLabel(m) {
  const head = headerLabel(m);
  return m.to.length > 0 ? `${head}\u2192${m.to.join(",")}` : head;
}
function listingDestination(m) {
  return m.scope === "dm" ? "dm" : m.room ?? "";
}
function logLine(m) {
  const body = normalizeBody(m.text).replace(/\n/g, " ");
  return `#${m.id.slice(-6)} ${m.id} ${listingLabel(m)} ${listingDestination(m)} ${body.slice(0, 80)}`;
}

// v6/hub/store.ts
import { Database } from "bun:sqlite";
import { mkdirSync as mkdirSync2 } from "fs";

// v6/hub/config.ts
var DEFAULT_CONFIG = {
  listen: "127.0.0.1:7900",
  bodyMaxBytes: 4096,
  toMaxPrincipals: 16,
  batchMaxMessages: 20,
  batchMaxCodePoints: 6000,
  batchMaxBytes: 8 * 1024,
  wakeCoalesceMs: 2000,
  wakeMinIntervalMs: 1e4,
  wakeHourlyLimit: 60,
  wakeWindowMs: 3600000,
  sendPerMinute: 30,
  loopBreakerLimit: 12,
  cooldownBaseMs: 10 * 60000,
  cooldownMaxMs: 2 * 3600000,
  cooldownDecayMs: 2 * 3600000,
  pendingMaxMessages: 1000,
  pendingMaxBytes: 4 * 1024 * 1024,
  roomMaxMessages: 1e4,
  roomMaxDays: 30,
  dmMaxMessages: 1e4,
  dmMaxDays: 30,
  batchRetryMs: 15 * 60000,
  logLimitMax: 200
};
var PRINCIPAL_RE = /^[a-z][a-z0-9-]{0,31}$/;
var ROOM_RE = /^[a-z0-9-]{1,32}$/;
var BINDING_RE = /^[a-z][a-z0-9-]{0,31}$/;
function hubRoots() {
  return {
    config: configDir(),
    state: stateDir(),
    db: join(stateDir(), "hub.db"),
    hubConfigPath: join(configDir(), "hub.json"),
    operatorCredentialPath: join(configDir(), "operator.json")
  };
}
function home(...p) {
  return [process.env.HOME ?? "/root", ...p].join("/");
}
function join(...parts) {
  return parts.filter(Boolean).join("/");
}
function stateDir() {
  const xdg = process.env.XDG_STATE_HOME ?? home(".local/state");
  return `${xdg.replace(/\/$/, "")}/vortex`;
}
function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME ?? home(".config");
  return `${xdg.replace(/\/$/, "")}/vortex`;
}

// v6/client/ulid.ts
var ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
var TIME_LEN = 10;
var RANDOM_LEN = 16;
function ulid(now = Date.now()) {
  let time = "";
  let t = now;
  for (let i = TIME_LEN;i > 0; i--) {
    time = ENCODING[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + randomPart();
}
function randomPart() {
  const bytes = new Uint8Array(RANDOM_LEN);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0;i < RANDOM_LEN; i++)
    out += ENCODING[bytes[i] % 32];
  return out;
}

// v6/hub/store.ts
var SCHEMA = `
CREATE TABLE IF NOT EXISTS principals (
  name TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bindings (
  principal TEXT NOT NULL,
  name TEXT NOT NULL,
  rooms TEXT NOT NULL,
  expired_pending INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (principal, name)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  ts INTEGER NOT NULL,
  scope TEXT NOT NULL,
  room TEXT,
  to_json TEXT NOT NULL,
  fromp TEXT NOT NULL,
  text TEXT NOT NULL,
  reply_to TEXT,
  human INTEGER NOT NULL,
  reply_author TEXT,
  reply_ts INTEGER
);
CREATE INDEX IF NOT EXISTS messages_room ON messages(room, seq);
CREATE INDEX IF NOT EXISTS messages_dm ON messages(scope, seq);
CREATE TABLE IF NOT EXISTS members (
  room TEXT NOT NULL,
  principal TEXT NOT NULL,
  PRIMARY KEY (room, principal)
);
CREATE TABLE IF NOT EXISTS conversations (
  conv TEXT PRIMARY KEY,
  auto_count INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  notice_pending INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pending (
  binding_principal TEXT NOT NULL,
  binding_name TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  enqueued TEXT NOT NULL,
  message_bytes INTEGER NOT NULL,
  PRIMARY KEY (binding_principal, binding_name, msg_id)
);
CREATE INDEX IF NOT EXISTS pending_order ON pending(binding_principal, binding_name, kind, enqueued);
CREATE TABLE IF NOT EXISTS wake_pushes (
  binding_principal TEXT NOT NULL,
  binding_name TEXT NOT NULL,
  conv TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS wake_pushes_binding ON wake_pushes(binding_principal, binding_name, ts);
CREATE TABLE IF NOT EXISTS cooldown_notices (
  conv TEXT NOT NULL,
  binding_principal TEXT NOT NULL,
  binding_name TEXT NOT NULL,
  cooling_until INTEGER NOT NULL,
  PRIMARY KEY (conv, binding_principal, binding_name)
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  binding_principal TEXT NOT NULL,
  binding_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  evidence TEXT,
  error TEXT,
  msg_ids TEXT NOT NULL,
  notices TEXT NOT NULL DEFAULT '[]',
  created INTEGER NOT NULL
);
`;
var dmPairKey = (a, b) => `dm:${[a, b].sort().join("|")}`;
var roomKey = (room) => `room:${room}`;
var convKeyOf = (m) => m.scope === "dm" ? dmPairKey(m.from, m.to[0]) : roomKey(m.room);
class HubStore {
  db;
  cfg;
  constructor(dbPath, cfg = DEFAULT_CONFIG) {
    this.cfg = cfg;
    mkdirSync2(dbPath.slice(0, dbPath.lastIndexOf("/")), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.migrate();
  }
  migrate() {
    this.db.transaction(() => {
      const cols = (t) => new Set(this.db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
      const conv = cols("conversations");
      for (const [c, ddl] of [
        ["cooling_until", "INTEGER"],
        ["level", "INTEGER NOT NULL DEFAULT 0"],
        ["last_auto_ts", "INTEGER"],
        ["last_cooldown_end", "INTEGER"],
        ["last_drain_ts", "INTEGER"]
      ])
        if (!conv.has(c))
          this.db.exec(`ALTER TABLE conversations ADD COLUMN ${c} ${ddl}`);
      if (!cols("pending").has("conv")) {
        this.db.exec("ALTER TABLE pending ADD COLUMN conv TEXT");
        const rows = this.db.prepare("SELECT p.rowid AS rid, m.scope, m.room, m.fromp, m.to_json FROM pending p JOIN messages m ON m.id = p.msg_id").all();
        const upd = this.db.prepare("UPDATE pending SET conv = ? WHERE rowid = ?");
        for (const r of rows)
          upd.run(convKeyOf({ scope: r.scope, room: r.room ?? undefined, from: r.fromp, to: JSON.parse(r.to_json) }), r.rid);
      }
      this.db.exec("CREATE INDEX IF NOT EXISTS pending_conv ON pending(conv, kind)");
      this.db.prepare("UPDATE conversations SET cooling_until = ?, level = 1, paused = 0, notice_pending = 0 WHERE paused = 1").run(Date.now() + this.cfg.cooldownBaseMs);
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema', 'a4') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    })();
  }
  close() {
    this.db.close();
  }
  createPrincipalUnchecked(name) {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const bytes = Buffer.from(raw).toString("base64").replace(/[+/=]/g, (s) => s === "+" ? "-" : s === "/" ? "_" : "");
    const token = `vt_${bytes}`;
    const hash = sha256Hex(token);
    this.db.prepare("INSERT INTO principals (name, token_hash, created) VALUES (?, ?, ?)").run(name, hash, Date.now());
    return { token };
  }
  createPrincipal(name) {
    if (name === "operator")
      throw new Error("operator is reserved; hub init creates it");
    if (!PRINCIPAL_RE.test(name))
      throw new Error(`invalid principal name: ${name}`);
    return this.db.transaction(() => this.createPrincipalUnchecked(name))();
  }
  verifyToken(token) {
    if (!token.startsWith("vt_"))
      return;
    const row = this.db.prepare("SELECT name FROM principals WHERE token_hash = ?").get(sha256Hex(token));
    return row?.name;
  }
  principalExists(name) {
    return this.db.prepare("SELECT 1 FROM principals WHERE name = ?").get(name) != null;
  }
  operatorExists() {
    return this.principalExists("operator");
  }
  enrolledNames(...names) {
    return names.filter((n) => this.principalExists(n));
  }
  setBinding(principal, name, rooms) {
    if (!BINDING_RE.test(name))
      throw new Error(`invalid binding name: ${name}`);
    for (const r of rooms)
      if (!ROOM_RE.test(r))
        throw new Error(`invalid room: ${r}`);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO bindings (principal, name, rooms, expired_pending) VALUES (?, ?, ?, 0)
         ON CONFLICT(principal, name) DO UPDATE SET rooms = excluded.rooms`).run(principal, name, JSON.stringify(rooms));
      for (const r of rooms)
        this.addMember(r, principal);
    })();
    return this.getBinding(principal, name);
  }
  getBinding(principal, name) {
    const row = this.db.prepare("SELECT principal, name, rooms, expired_pending FROM bindings WHERE principal = ? AND name = ?").get(principal, name);
    if (!row)
      return;
    return { principal: row.principal, name: row.name, rooms: JSON.parse(row.rooms), expiredPending: row.expired_pending };
  }
  bindingsOf(principal) {
    const rows = this.db.prepare("SELECT principal, name, rooms, expired_pending FROM bindings WHERE principal = ?").all(principal);
    return rows.map((r) => ({ principal: r.principal, name: r.name, rooms: JSON.parse(r.rooms), expiredPending: r.expired_pending }));
  }
  allBindings() {
    const rows = this.db.prepare("SELECT principal, name, rooms, expired_pending FROM bindings ORDER BY principal, name").all();
    return rows.map((r) => ({ principal: r.principal, name: r.name, rooms: JSON.parse(r.rooms), expiredPending: r.expired_pending }));
  }
  deliverableBindingsForRoom(room, senderPrincipal) {
    const rows = this.db.prepare(`SELECT principal, name, rooms, expired_pending FROM bindings WHERE principal != ? ORDER BY principal, name`).all(senderPrincipal);
    return rows.map((r) => ({ principal: r.principal, name: r.name, rooms: JSON.parse(r.rooms), expiredPending: r.expired_pending })).filter((b) => b.rooms.includes(room));
  }
  addMember(room, principal) {
    this.db.prepare("INSERT OR IGNORE INTO members (room, principal) VALUES (?, ?)").run(room, principal);
  }
  isMember(room, principal) {
    return this.db.prepare("SELECT 1 FROM members WHERE room = ? AND principal = ?").get(room, principal) != null;
  }
  memberRooms(principal) {
    return this.db.prepare("SELECT room FROM members WHERE principal = ? ORDER BY room").all(principal).map((r) => r.room);
  }
  getMessage(id) {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    return row == null ? undefined : this.rowToMessage(row);
  }
  getMessagesByIds(ids) {
    const out = [];
    const stmt = this.db.prepare("SELECT * FROM messages WHERE id = ?");
    for (const id of ids) {
      const row = stmt.get(id);
      if (row != null)
        out.push(this.rowToMessage(row));
    }
    return out;
  }
  rowToMessage(row) {
    return {
      id: row.id,
      seq: row.seq,
      ts: row.ts,
      scope: row.scope,
      room: row.room === null ? undefined : row.room,
      to: JSON.parse(row.to_json),
      from: row.fromp,
      text: row.text,
      reply_to: row.reply_to === null ? undefined : row.reply_to,
      human: row.human === 1,
      reply_author: row.reply_author === null ? undefined : row.reply_author,
      reply_ts: row.reply_ts === null ? undefined : row.reply_ts
    };
  }
  atomic(fn) {
    return this.db.transaction(fn)();
  }
  insertMessage(m) {
    const now = Date.now();
    const conversationKey = m.scope === "dm" ? dmPairKey(m.from, m.to[0]) : roomKey(m.room);
    const toJson = JSON.stringify(m.to);
    const built = this.db.transaction(() => {
      const id = ulid(now);
      const seq = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages").get().next;
      let reply_author = undefined;
      let reply_ts = undefined;
      if (m.reply_to !== undefined) {
        const r = this.getMessage(m.reply_to);
        reply_author = r?.from;
        reply_ts = r?.ts;
      }
      this.db.prepare(`INSERT INTO messages (id, seq, ts, scope, room, to_json, fromp, text, reply_to, human, reply_author, reply_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, seq, now, m.scope, m.room ?? null, toJson, m.from, m.text, m.reply_to ?? null, m.human ? 1 : 0, reply_author ?? null, reply_ts ?? null);
      if (m.scope === "room")
        this.addMember(m.room, m.from);
      const bump = this.bumpConversation(conversationKey, m.from, m.human, now);
      const msg = { id, seq, ts: now, scope: m.scope, room: m.room, to: m.to, from: m.from, text: m.text, reply_to: m.reply_to, human: m.human, reply_author, reply_ts };
      this.pruneRetention(msg);
      return { ...msg, conversationKey, ...bump };
    })();
    return built;
  }
  bumpConversation(conv, from, human, now) {
    this.db.prepare("INSERT INTO conversations (conv) VALUES (?) ON CONFLICT(conv) DO NOTHING").run(conv);
    if (from === "operator") {
      const was = this.conversationRow(conv);
      this.db.prepare(`UPDATE conversations SET auto_count = 0, level = 0, cooling_until = NULL, paused = 0,
           last_cooldown_end = CASE WHEN cooling_until IS NOT NULL THEN ? ELSE last_cooldown_end END WHERE conv = ?`).run(now, conv);
      this.db.prepare("DELETE FROM cooldown_notices WHERE conv = ?").run(conv);
      return { enteredCooldown: false, operatorReset: was.coolingUntil !== null, expiredInline: false };
    }
    if (human)
      return { enteredCooldown: false, operatorReset: false, expiredInline: false };
    const expiredInline = this.expireConversation(conv, now);
    const prior = this.conversationRow(conv);
    if (prior.level > 0 && prior.coolingUntil === null && !this.hasWakeWork(conv)) {
      const quietSince = Math.max(prior.lastAutoTs ?? 0, prior.lastCooldownEnd ?? 0, prior.lastDrainTs ?? 0);
      if (now - quietSince >= this.cfg.cooldownDecayMs)
        this.db.prepare("UPDATE conversations SET level = 0 WHERE conv = ?").run(conv);
    }
    this.db.prepare("UPDATE conversations SET auto_count = auto_count + 1, last_auto_ts = ? WHERE conv = ?").run(now, conv);
    const cur = this.conversationRow(conv);
    if (cur.coolingUntil === null && cur.count >= this.cfg.loopBreakerLimit) {
      const level = cur.level + 1;
      const until = now + Math.min(this.cfg.cooldownBaseMs * 2 ** (level - 1), this.cfg.cooldownMaxMs);
      this.db.prepare("UPDATE conversations SET level = ?, cooling_until = ? WHERE conv = ?").run(level, until, conv);
      this.recordCooldownNotices(conv, until);
      return { enteredCooldown: true, operatorReset: false, expiredInline };
    }
    return { enteredCooldown: false, operatorReset: false, expiredInline };
  }
  recordCooldownNotices(conv, until) {
    let targets;
    if (conv.startsWith("dm:")) {
      const [a, b] = conv.slice(3).split("|");
      targets = [...this.bindingsOf(a), ...this.bindingsOf(b)];
    } else {
      targets = this.deliverableBindingsForRoom(conv.slice(5), "");
    }
    const stmt = this.db.prepare(`INSERT INTO cooldown_notices (conv, binding_principal, binding_name, cooling_until) VALUES (?, ?, ?, ?)
       ON CONFLICT(conv, binding_principal, binding_name) DO UPDATE SET cooling_until = excluded.cooling_until`);
    for (const t of targets)
      stmt.run(conv, t.principal, t.name, until);
  }
  conversationRow(conv) {
    const r = this.db.prepare("SELECT * FROM conversations WHERE conv = ?").get(conv);
    if (r == null)
      return;
    return { conv: r.conv, count: r.auto_count, level: r.level, coolingUntil: r.cooling_until, lastAutoTs: r.last_auto_ts, lastCooldownEnd: r.last_cooldown_end, lastDrainTs: r.last_drain_ts };
  }
  isCooling(conv, now) {
    const r = this.db.prepare("SELECT cooling_until FROM conversations WHERE conv = ?").get(conv);
    return r != null && r.cooling_until !== null && r.cooling_until > now;
  }
  hasWakeWork(conv) {
    return this.db.prepare("SELECT 1 FROM pending WHERE conv = ? AND kind = 'wake' LIMIT 1").get(conv) != null;
  }
  expireConversation(conv, now) {
    const r = this.db.prepare("UPDATE conversations SET auto_count = 0, last_cooldown_end = cooling_until, cooling_until = NULL WHERE conv = ? AND cooling_until IS NOT NULL AND cooling_until <= ?").run(conv, now);
    return r.changes > 0;
  }
  expireCooldowns(now) {
    return this.db.transaction(() => {
      const due = this.db.prepare("SELECT conv FROM conversations WHERE cooling_until IS NOT NULL AND cooling_until <= ?").all(now).map((r) => r.conv);
      for (const c of due)
        this.expireConversation(c, now);
      return due;
    })();
  }
  nextCoolingExpiry() {
    const r = this.db.prepare("SELECT MIN(cooling_until) AS t FROM conversations WHERE cooling_until IS NOT NULL").get();
    return r?.t ?? undefined;
  }
  bindingsHoldingWake(conv) {
    return this.db.prepare("SELECT DISTINCT binding_principal AS p, binding_name AS n FROM pending WHERE conv = ? AND kind = 'wake'").all(conv).map((r) => ({ principal: r.p, name: r.n }));
  }
  coolingConversations(now) {
    const rows = this.db.prepare("SELECT conv, cooling_until, level FROM conversations WHERE cooling_until IS NOT NULL AND cooling_until > ? ORDER BY conv").all(now);
    return rows.map((r) => {
      const held = {};
      for (const h of this.db.prepare("SELECT binding_principal AS p, binding_name AS n, COUNT(*) AS c FROM pending WHERE conv = ? AND kind = 'wake' GROUP BY p, n").all(r.conv))
        held[`${h.p}/${h.n}`] = h.c;
      return { conv: r.conv, until: r.cooling_until, level: r.level, held };
    });
  }
  peekCooldownNotice(conv, principal, binding) {
    const r = this.db.prepare("SELECT cooling_until FROM cooldown_notices WHERE conv = ? AND binding_principal = ? AND binding_name = ?").get(conv, principal, binding);
    if (r == null)
      return;
    const d = new Date(r.cooling_until);
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return `[vx: conversation cooled down after ${this.cfg.loopBreakerLimit} automatic messages until ${hhmm}]`;
  }
  takeCooldownNotice(conv, principal, binding) {
    this.db.prepare("DELETE FROM cooldown_notices WHERE conv = ? AND binding_principal = ? AND binding_name = ?").run(conv, principal, binding);
  }
  recordWakePush(principal, binding, conv, batchId, ts) {
    this.db.prepare("INSERT INTO wake_pushes (binding_principal, binding_name, conv, batch_id, ts) VALUES (?, ?, ?, ?, ?)").run(principal, binding, conv, batchId, ts);
    this.db.prepare("DELETE FROM wake_pushes WHERE binding_principal = ? AND binding_name = ? AND ts <= ?").run(principal, binding, ts - this.cfg.wakeWindowMs);
  }
  wakePushTimes(principal, binding, now) {
    return this.db.prepare("SELECT ts FROM wake_pushes WHERE binding_principal = ? AND binding_name = ? AND ts > ? ORDER BY ts").all(principal, binding, now - this.cfg.wakeWindowMs).map((r) => r.ts);
  }
  wakePushCount(principal, binding, since) {
    return this.db.prepare("SELECT COUNT(*) AS c FROM wake_pushes WHERE binding_principal = ? AND binding_name = ? AND ts > ?").get(principal, binding, since).c;
  }
  lastWakePush(principal, binding) {
    return this.db.prepare("SELECT MAX(ts) AS t FROM wake_pushes WHERE binding_principal = ? AND binding_name = ?").get(principal, binding)?.t ?? 0;
  }
  lastServed(principal, binding) {
    const rows = this.db.prepare("SELECT conv, MAX(ts) AS t FROM wake_pushes WHERE binding_principal = ? AND binding_name = ? GROUP BY conv").all(principal, binding);
    return new Map(rows.map((r) => [r.conv, r.t]));
  }
  pruneRetention(m) {
    if (m.scope === "room") {
      this.db.prepare(`DELETE FROM messages WHERE room = ? AND id NOT IN (SELECT msg_id FROM pending) AND seq <=
           (SELECT COALESCE(MIN(seq), 0) - 1 FROM (SELECT seq FROM messages WHERE room = ? ORDER BY seq DESC LIMIT 1 OFFSET ?))`).run(m.room, m.room, this.cfg.roomMaxMessages);
      const cutoff = Date.now() - this.cfg.roomMaxDays * 86400000;
      this.db.prepare(`DELETE FROM messages WHERE room = ? AND id NOT IN (SELECT msg_id FROM pending) AND ts < ?`).run(m.room, cutoff);
    } else {
      this.db.prepare(`DELETE FROM messages WHERE scope = 'dm' AND id NOT IN (SELECT msg_id FROM pending) AND seq <=
           (SELECT COALESCE(MIN(seq), 0) - 1 FROM (SELECT seq FROM messages WHERE scope = 'dm' AND (fromp = ? OR to_json = ?) ORDER BY seq DESC LIMIT 1 OFFSET ?))`).run(m.from, JSON.stringify(m.to), this.cfg.dmMaxMessages);
      const cutoff = Date.now() - this.cfg.dmMaxDays * 86400000;
      this.db.prepare(`DELETE FROM messages WHERE scope = 'dm' AND id NOT IN (SELECT msg_id FROM pending) AND ts < ? AND (fromp = ? OR to_json = ?)`).run(cutoff, m.from, JSON.stringify(m.to));
    }
  }
  roomLog(room, after, limit) {
    const rows = this.db.prepare(`SELECT * FROM messages WHERE room = ? AND seq > ? ORDER BY seq LIMIT ?`).all(room, after, limit);
    return rows.map((r) => this.rowToMessage(r));
  }
  dmLog(principal, after, limit) {
    const rows = this.db.prepare(`SELECT * FROM messages WHERE scope = 'dm' AND (fromp = ? OR to_json = ?) AND seq > ? ORDER BY seq LIMIT ?`).all(principal, JSON.stringify([principal]), after, limit);
    return rows.map((r) => this.rowToMessage(r));
  }
  recentFor(principal, limit) {
    const rows = this.db.prepare(`SELECT * FROM messages
       WHERE (scope = 'room' AND room IN (SELECT room FROM members WHERE principal = ?))
          OR (scope = 'dm' AND (fromp = ? OR to_json = ?))
       ORDER BY seq DESC LIMIT ?`).all(principal, principal, JSON.stringify([principal]), limit);
    return rows.map((r) => this.rowToMessage(r));
  }
  recentGlobal(limit) {
    return this.db.prepare("SELECT * FROM messages ORDER BY seq DESC LIMIT ?").all(limit).map((r) => this.rowToMessage(r));
  }
  dmLogAll(after, limit) {
    const rows = this.db.prepare(`SELECT * FROM messages WHERE scope = 'dm' AND seq > ? ORDER BY seq LIMIT ?`).all(after, limit);
    return rows.map((r) => this.rowToMessage(r));
  }
  roomSeqHead(room) {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE room = ?").get(room);
    return row.s;
  }
  seqHead() {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM messages").get();
    return row.s;
  }
  enqueuePending(principal, binding, m, kind) {
    let dropped = 0;
    let nowOverBoundary = false;
    const bytes = utf8Count(m.text);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO pending (binding_principal, binding_name, msg_id, kind, enqueued, message_bytes, conv)
         VALUES (?, ?, ?, ?, ?, ?, ?)`).run(principal, binding, m.id, kind, ulid(Date.now()), bytes, convKeyOf(m));
      const stats = this.pendingStats(principal, binding);
      while (stats.count > this.cfg.pendingMaxMessages || stats.bytes > this.cfg.pendingMaxBytes) {
        const oldest = this.db.prepare(`SELECT msg_id FROM pending WHERE binding_principal = ? AND binding_name = ? ORDER BY rowid LIMIT 1`).get(principal, binding);
        if (oldest === undefined)
          break;
        this.db.prepare("DELETE FROM pending WHERE binding_principal = ? AND binding_name = ? AND msg_id = ?").run(principal, binding, oldest.msg_id);
        const row = this.pendingStats(principal, binding);
        stats.count = row.count;
        stats.bytes = row.bytes;
        dropped++;
      }
      if (dropped > 0) {
        this.db.prepare("UPDATE bindings SET expired_pending = expired_pending + ? WHERE principal = ? AND name = ?").run(dropped, principal, binding);
        nowOverBoundary = true;
      }
    })();
    return { overflowDropped: dropped, nowOverBoundary };
  }
  pendingStats(principal, binding) {
    const row = this.db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(message_bytes), 0) AS b FROM pending WHERE binding_principal = ? AND binding_name = ?`).get(principal, binding);
    return { count: row.c, bytes: row.b };
  }
  pendingCountByKind(principal, binding) {
    const rows = this.db.prepare(`SELECT kind, COUNT(*) AS c FROM pending WHERE binding_principal = ? AND binding_name = ? GROUP BY kind`).all(principal, binding);
    const out = { wake: 0, passive: 0 };
    for (const r of rows)
      out[r.kind] = r.c;
    return out;
  }
  pendingMessages(principal, binding, kind) {
    const rows = this.db.prepare(`SELECT m.* FROM pending p JOIN messages m ON m.id = p.msg_id
       WHERE p.binding_principal = ? AND p.binding_name = ? AND p.kind = ?
       ORDER BY p.rowid`).all(principal, binding, kind);
    return rows.map((r) => this.rowToMessage(r));
  }
  deletePending(principal, binding, ids) {
    const stmt = this.db.prepare("DELETE FROM pending WHERE binding_principal = ? AND binding_name = ? AND msg_id = ?");
    for (const id of ids)
      stmt.run(principal, binding, id);
  }
  consumeExpiredNotice(principal, binding) {
    const b = this.getBinding(principal, binding);
    if (b === undefined)
      return 0;
    const n = b.expiredPending;
    if (n > 0)
      this.db.prepare("UPDATE bindings SET expired_pending = 0 WHERE principal = ? AND name = ?").run(principal, binding);
    return n;
  }
  insertBatchRow(b) {
    this.db.prepare(`INSERT INTO deliveries (id, binding_principal, binding_name, kind, status, msg_ids, notices, created)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`).run(b.id, b.principal, b.binding, b.kind, JSON.stringify(b.msgIds), JSON.stringify(b.notices), Date.now());
  }
  getBatch(id) {
    const row = this.db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id);
    if (row == null)
      return;
    return {
      id: row.id,
      principal: row.binding_principal,
      binding: row.binding_name,
      kind: row.kind,
      status: row.status,
      error: row.error === null ? undefined : row.error,
      msgIds: JSON.parse(row.msg_ids),
      notices: JSON.parse(row.notices),
      created: row.created
    };
  }
  outstandingBatch(principal, binding, kind) {
    const row = this.db.prepare(`SELECT * FROM deliveries WHERE binding_principal = ? AND binding_name = ? AND kind = ? AND status IN ('pending','failed')
       ORDER BY created DESC, id DESC LIMIT 1`).get(principal, binding, kind);
    if (!row)
      return;
    return { id: row.id, principal: row.binding_principal, binding: row.binding_name, kind: row.kind, status: row.status, error: row.error === null ? undefined : row.error, msgIds: JSON.parse(row.msg_ids), notices: JSON.parse(row.notices), created: row.created };
  }
  outstandingBatchesOf(principal, binding) {
    const wake = this.outstandingBatch(principal, binding, "wake");
    const passive = this.outstandingBatch(principal, binding, "passive");
    return [wake, passive].filter((x) => x !== undefined);
  }
  deliverBatch(id, evidence) {
    this.db.transaction(() => {
      const row = this.getBatch(id);
      if (row != null) {
        const convs = new Set(this.db.prepare(`SELECT DISTINCT conv FROM pending WHERE binding_principal = ? AND binding_name = ? AND msg_id IN (${row.msgIds.map(() => "?").join(",") || "''"})`).all(row.principal, row.binding, ...row.msgIds).map((r) => r.conv));
        this.deletePending(row.principal, row.binding, row.msgIds);
        const now = Date.now();
        for (const c of convs)
          if (c !== null && !this.hasWakeWork(c))
            this.db.prepare("UPDATE conversations SET last_drain_ts = ? WHERE conv = ?").run(now, c);
        this.db.prepare(`UPDATE deliveries SET status = 'delivered', evidence = ? WHERE id = ?`).run(evidence, id);
        this.db.prepare(`DELETE FROM deliveries
           WHERE binding_principal = ? AND binding_name = ? AND status = 'delivered' AND id != ?`).run(row.principal, row.binding, id);
      }
    })();
  }
  markBatchFailed(id, error) {
    this.db.prepare(`UPDATE deliveries SET status = 'failed', error = ? WHERE id = ?`).run(error, id);
  }
  keepBatchPending(id) {
    this.db.prepare(`UPDATE deliveries SET status = 'pending', error = NULL WHERE id = ?`).run(id);
  }
  deleteBatchRow(id) {
    this.db.prepare("DELETE FROM deliveries WHERE id = ?").run(id);
  }
}
function utf8Count(s) {
  return new TextEncoder().encode(s).length;
}
function sha256Hex(s) {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(s);
  return hasher.digest("hex");
}

// v6/cli/hook.ts
import { connect } from "net";

// v6/client/hooksocket.ts
function bindingName() {
  return process.env.VORTEX_BINDING ?? "default";
}
function runtimeDir() {
  const base = process.env.XDG_RUNTIME_DIR ?? `/tmp/vortex-${process.getuid?.() ?? "user"}`;
  return `${base.replace(/\/$/, "")}/vortex`;
}
function socketPath(binding = bindingName(), host = "claude") {
  return `${runtimeDir()}/${host}-${binding.replace(/[^A-Za-z0-9_.-]/g, "_")}.sock`;
}

// v6/cli/hook.ts
var EVENTS = new Set(["UserPromptSubmit", "PostToolUse"]);
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      data += c;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}
async function hookContext(host = "claude") {
  let event = {};
  try {
    event = JSON.parse(await readStdin());
  } catch {}
  const eventName = event.hook_event_name;
  const sock = connect(socketPath(bindingName(), host));
  const lines = [];
  const waiters = [];
  let buf = "";
  let dead = false;
  sock.setEncoding("utf8");
  sock.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf(`
`)) >= 0) {
      try {
        lines.push(JSON.parse(buf.slice(0, i)));
      } catch {}
      buf = buf.slice(i + 1);
      waiters.splice(0).forEach((w) => w());
    }
  });
  const end = () => {
    dead = true;
    waiters.splice(0).forEach((w) => w());
  };
  sock.on("close", end);
  sock.on("error", end);
  const next = async (ms) => {
    const deadline = Date.now() + ms;
    while (lines.length === 0 && !dead) {
      const left = deadline - Date.now();
      if (left <= 0)
        return;
      await new Promise((r) => {
        const t = setTimeout(r, left);
        waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
    return lines.shift();
  };
  const send = (r) => {
    sock.write(JSON.stringify(r) + `
`);
  };
  await new Promise((resolve) => {
    sock.once("connect", resolve);
    sock.once("error", resolve);
  });
  if (dead)
    return;
  send({ op: "context", event });
  const res = await next(5000);
  if (res === undefined || !res.ok || res.context === undefined || res.batch === undefined || typeof eventName !== "string" || !EVENTS.has(eventName)) {
    sock.destroy();
    return;
  }
  const out = JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: res.context } }) + `
`;
  try {
    await new Promise((resolve, reject) => process.stdout.write(out, (err) => err ? reject(err) : resolve()));
  } catch {
    sock.destroy();
    return;
  }
  send({ op: "ack", batch: res.batch });
  await next(2000);
  sock.destroy();
}

// v6/plugins/codex/binding.ts
import { chmodSync as chmodSync2, existsSync as existsSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "fs";
function bindingFile(binding) {
  return `${vortexConfigDir()}/codex-thread-${binding.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`;
}
function saveThreadBinding(binding, thread) {
  mkdirSync3(vortexConfigDir(), { recursive: true, mode: 448 });
  const path = bindingFile(binding);
  writeFileSync2(path, JSON.stringify({ thread, binding, boundAt: Date.now() }, null, 2) + `
`, { mode: 384 });
  chmodSync2(path, 384);
}

// v6/plugins/codex/appserver.ts
class AppServerError extends Error {
  kind;
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}
function appServerCommand() {
  const override = process.env.VORTEX_CODEX_APPSERVER_CMD;
  if (override !== undefined) {
    const parsed = JSON.parse(override);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((a) => typeof a !== "string")) {
      throw new Error("VORTEX_CODEX_APPSERVER_CMD must be a JSON array of strings");
    }
    return parsed;
  }
  return [process.env.CODEX_CLI_PATH ?? "codex", "app-server", "proxy"];
}

class StdioAppServer {
  proc;
  connecting;
  pending = new Map;
  nextId = 1;
  requestTimeoutMs;
  command;
  constructor(command = appServerCommand, requestTimeoutMs = 30000) {
    this.command = command;
    this.requestTimeoutMs = requestTimeoutMs;
  }
  write(obj) {
    const stdin = this.proc.stdin;
    stdin.write(JSON.stringify(obj) + `
`);
    stdin.flush();
  }
  dropConnection(reason) {
    this.proc = undefined;
    this.connecting = undefined;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new AppServerError("disconnect", reason));
      this.pending.delete(id);
    }
  }
  async pump(proc) {
    let buf = "";
    const dec = new TextDecoder;
    try {
      for await (const chunk of proc.stdout) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf(`
`)) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line.length > 0)
            this.onLine(proc, line);
        }
      }
    } catch {}
    if (this.proc === proc)
      this.dropConnection("app-server connection closed");
  }
  onLine(proc, line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg === null || typeof msg !== "object")
      return;
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (p === undefined)
        return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error !== undefined)
        p.reject(new AppServerError("rpc", `${msg.error?.code ?? ""} ${msg.error?.message ?? "error"}`.trim()));
      else
        p.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && msg.method !== undefined && this.proc === proc) {
      this.write({ id: msg.id, error: { code: -32601, message: "method not supported by the vortex client" } });
    }
  }
  rawRequest(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerError("timeout", `${method} got no response within ${this.requestTimeoutMs} ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new AppServerError("disconnect", e.message));
      }
    });
  }
  connect() {
    if (this.connecting !== undefined)
      return this.connecting;
    const attempt = (async () => {
      let proc;
      try {
        proc = Bun.spawn(this.command(), { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
      } catch (e) {
        throw new AppServerError("spawn", `cannot start the app-server proxy: ${e.message}`);
      }
      this.proc = proc;
      this.pump(proc);
      proc.exited.then(() => {
        if (this.proc === proc)
          this.dropConnection("app-server proxy exited");
      });
      await this.rawRequest("initialize", {
        clientInfo: { name: "vortex", title: "VORTEX", version: "6.0.0" },
        capabilities: { experimentalApi: true }
      });
      this.write({ method: "initialized" });
    })();
    this.connecting = attempt;
    attempt.catch(() => {
      if (this.connecting === attempt) {
        this.connecting = undefined;
        try {
          this.proc?.kill();
        } catch {}
        this.proc = undefined;
      }
    });
    return attempt;
  }
  async request(method, params) {
    await this.connect();
    return await this.rawRequest(method, params);
  }
  close() {
    const proc = this.proc;
    this.dropConnection("closed");
    try {
      proc?.kill();
    } catch {}
  }
}

// v6/cli/codex.ts
async function bindThread(thread, server, binding = bindingName()) {
  if (thread === undefined || thread.length === 0) {
    let listing = "";
    try {
      const res = await server.request("thread/list", { limit: 10 });
      const rows = Array.isArray(res?.data) ? res.data : [];
      listing = rows.map((t) => `  ${t.id}  ${String(t.name ?? t.preview ?? "").slice(0, 60)}`).join(`
`);
    } catch {}
    return {
      ok: false,
      message: "no chat selected: pass a thread id (vx codex bind <thread-id>) or run this from inside the chat ($CODEX_THREAD_ID)." + (listing === "" ? "" : `
recent chats:
${listing}`)
    };
  }
  let res;
  try {
    res = await server.request("thread/read", { threadId: thread });
  } catch (e) {
    return { ok: false, message: `cannot verify chat against the running Codex host (${e.message}); nothing stored` };
  }
  if (res?.thread?.id !== thread) {
    return { ok: false, message: "the host did not confirm that chat; nothing stored" };
  }
  saveThreadBinding(binding, thread);
  return { ok: true, message: `bound binding "${binding}" to the chat ${thread} (stored locally only; never sent to the hub)` };
}
async function codexBind(args) {
  const server = new StdioAppServer;
  try {
    const r = await bindThread(args[0] ?? process.env.CODEX_THREAD_ID, server);
    (r.ok ? console.log : console.error)(r.ok ? r.message : `vx: ${r.message}`);
    return r.ok ? 0 : 1;
  } finally {
    server.close();
  }
}

// v6/cli/vx.ts
var USAGE = `vx \u2014 operator CLI for VORTEX v6

  vx enroll <name>                          enroll a principal (hub host)
  vx say [--to a,b] [--room r] [--scope room|dm] [--reply-to <id>] <text>
  vx log [<room>]|--dm [--after seq] [--limit n]   ids + refs printed (A1)
  vx status
  vx binding release <principal>/<name>
  vx codex bind [<thread-id>]               select the Codex chat for wakes (default $CODEX_THREAD_ID)
  vx hook context [--host claude|codex]     (plugins only: hook event JSON on stdin)
`;
function die(message) {
  console.error(`vx: ${message}`);
  process.exit(1);
}
function operatorClient() {
  const credential = loadCredential("operator");
  if (credential === undefined) {
    die(`no operator credential at ${vortexConfigDir()}/operator.json; run vortexd on this machine (bun v6/hub/main.ts)`);
  }
  return new VortexClient(credential);
}
function parseArgs(rest) {
  const flags = new Map;
  const bare = [];
  const bools = new Set;
  for (let i = 0;i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) {
      bare.push(a);
      continue;
    }
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(a.slice(2), next);
      i++;
    } else {
      bools.add(a.slice(2));
    }
  }
  return { flags, bare, bools };
}
async function main() {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv;
  if (command === undefined || command === "-h" || command === "--help" || command === "help") {
    console.log(USAGE);
    process.exit(0);
  }
  if (command === "enroll") {
    const name = rest[0];
    if (name === undefined || !PRINCIPAL_RE.test(name))
      die(`enroll takes a principal name matching ${PRINCIPAL_RE}`);
    const roots = hubRoots();
    if (!existsSync3(roots.db))
      die(`no hub database at ${roots.db}; run vortexd on this host first`);
    mkdirSync4(roots.config, { recursive: true, mode: 448 });
    const store = new HubStore(roots.db);
    let token = "";
    try {
      token = store.createPrincipal(name).token;
    } catch (e) {
      const message = e.message;
      if (message.includes("UNIQUE"))
        die("already enrolled");
      if (message.includes("operator"))
        die(message);
      throw e;
    } finally {
      store.close();
    }
    let fingerprint;
    const certPath = `${roots.state}/cert.pem`;
    if (existsSync3(certPath)) {
      const der = Bun.spawnSync(["openssl", "x509", "-in", certPath, "-outform", "DER"]).stdout;
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(der);
      fingerprint = hasher.digest("hex");
    }
    console.log(`token: ${token}`);
    if (fingerprint !== undefined)
      console.log(`fingerprint: ${fingerprint}`);
    console.log("(stored hashed by the hub; shown once \u2014 keep it in the client credential file)");
    return;
  }
  if (command === "say") {
    const { flags, bare } = parseArgs(rest);
    const text = bare.join(" ");
    if (text.length === 0)
      die("say takes the message text");
    const scope = flags.get("scope");
    if (scope !== undefined && scope !== "room" && scope !== "dm")
      die("scope is room|dm");
    const room = flags.get("room");
    if (scope === "dm" && room !== undefined)
      die("a DM takes no room");
    const to = (flags.get("to") ?? "").split(",").filter((w) => w.length > 0);
    if (scope === "dm" && to.length !== 1)
      die("a DM needs exactly one recipient: --to <name>");
    const client = operatorClient();
    const { id, seq } = await client.send({
      text,
      ...scope === undefined ? {} : { scope },
      ...room === undefined ? {} : { room },
      ...to.length === 0 ? {} : { to },
      ...flags.get("reply-to") === undefined ? {} : { reply_to: flags.get("reply-to") }
    });
    console.log(`${id} seq ${seq}`);
    return;
  }
  if (command === "log") {
    const { flags, bare, bools } = parseArgs(rest);
    const after = Number(flags.get("after") ?? 0);
    const limit = Number(flags.get("limit") ?? 100);
    if (!Number.isInteger(after) || !Number.isInteger(limit))
      die("log flags --after/--limit take integers");
    const client = operatorClient();
    if (bools.has("dm")) {
      const res = await client.dmLog(after, limit);
      for (const m of res.messages)
        console.log(logLine(m));
      return;
    }
    const room = bare.length === 1 ? bare[0] : flags.get("room");
    if (room === undefined)
      die("log takes a room: vx log <room>  (or vx log --dm)");
    const res = await client.roomLog(room, after, limit);
    for (const m of res.messages)
      console.log(logLine(m));
    return;
  }
  if (command === "status") {
    const client = operatorClient();
    console.log(JSON.stringify(await client.status(), null, 2));
    return;
  }
  if (command === "binding") {
    if (rest[0] !== "release")
      die('binding takes "release <principal>/<name>"');
    const [principal, name] = (rest[1] ?? "").split("/");
    if (!principal || !name)
      die("binding release takes <principal>/<name>");
    const client = operatorClient();
    await client.release(principal, name);
    console.log(`released ${principal}/${name}`);
    return;
  }
  if (command === "codex") {
    if (rest[0] !== "bind")
      die('codex takes "bind [<thread-id>]"');
    process.exit(await codexBind(rest.slice(1)));
  }
  if (command === "hook") {
    if (rest[0] !== "context")
      die('hook takes "context"');
    const h = rest.indexOf("--host");
    const host = h >= 0 ? rest[h + 1] : "claude";
    if (host !== "claude" && host !== "codex")
      die("hook --host is claude|codex");
    await hookContext(host);
    process.exit(0);
  }
  die(`unknown command: ${command}
${USAGE}`);
}
main();
