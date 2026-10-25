// Topic router for the Claude ring adapter: one durable session per topic key.
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

const dir = process.env.VORTEX_DIR;
if (!dir) {
  console.error('claude-topics: VORTEX_DIR is required');
  process.exit(1);
}

const configDir = process.env.CLAUDE_CONFIG_DIR || (process.env.HOME ? process.env.HOME + '/.claude' : '');
const projectsDir = configDir ? resolve(configDir, 'projects') : '';

// Claude Code keeps a session as projects/<project dir>/<session id>.jsonl.
const sessionExists = (sessionId) => {
  if (!projectsDir) return false;
  let projects;
  try { projects = readdirSync(projectsDir, { withFileTypes: true }); } catch { return false; }
  return projects.some((project) => project.isDirectory() &&
    existsSync(resolve(projectsDir, project.name, sessionId + '.jsonl')));
};

// The service's unread view leaves out acknowledged and already-handled
// events. VORTEX_ROOM, set by a ring, narrows it to the room that ring was
// charged to, so this run handles the mail its ring paid for (and acks it
// with --room, never touching another room's mail).
const room = process.env.VORTEX_ROOM || undefined;
const run = spawnSync('bun', ['src/cli.ts', 'read', '--dir', dir, ...(room ? ['--room', room] : [])], {
  cwd: repoRoot,
  encoding: 'utf8',
});
if (run.status !== 0) {
  console.error(run.stderr || 'claude-topics: read failed');
  process.exit(run.status ?? 1);
}
let parsed;
try {
  parsed = JSON.parse(run.stdout);
} catch (e) {
  console.error('claude-topics: invalid read output');
  process.exit(1);
}
const CONTROL_KINDS = new Set(['match', 'invitation', 'accepted', 'formed', 'arrival', 'departure', 'closed']);
const events = (Array.isArray(parsed?.events) ? parsed.events : [])
  .filter((e) => e && Number.isSafeInteger(e.cursor) && (!room || e.room === room) && !CONTROL_KINDS.has(e.kind));

if (events.length === 0) {
  console.log(JSON.stringify({ none: true }));
  process.exit(0);
}

const validConference = (v) => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);
const topicKey = (e) => {
  if (Object.prototype.hasOwnProperty.call(e, 'conference') && validConference(e.conference))
    return `conference:${e.conference}`;
  if (Object.prototype.hasOwnProperty.call(e, 'routingConference') && validConference(e.routingConference))
    return `conference:${e.routingConference}`;
  return `cursor:${e.cursor}`;
};

const key = topicKey(events[0]);
const runEvents = [];
// The run is contiguous within the unread view, so an ack through its last
// cursor (scoped to the room when one was charged) covers only this run.
for (const e of events) {
  if (topicKey(e) !== key) break;
  runEvents.push(e);
}
const first = runEvents[0].cursor;
const through = runEvents[runEvents.length - 1].cursor;
const count = runEvents.length;

const mapPath = resolve(dir, 'claude-topics.json');
let map = {};
if (existsSync(mapPath)) {
  let raw;
  try {
    raw = readFileSync(mapPath, 'utf8');
  } catch (e) {
    console.error(`claude-topics: cannot read ${mapPath}: ${e.message}`);
    process.exit(1);
  }
  try {
    map = JSON.parse(raw);
  } catch (e) {
    console.error(`claude-topics: invalid JSON in ${mapPath}: ${e.message}`);
    process.exit(1);
  }
  if (typeof map !== 'object' || map === null || Array.isArray(map)) {
    console.error(`claude-topics: ${mapPath} must contain a JSON object`);
    process.exit(1);
  }
}

let entry = map[key];
let isNew = false;
if (!entry || typeof entry.session !== 'string') {
  entry = { session: randomUUID(), created: Date.now(), last: Date.now() };
  isNew = true;
} else {
  entry = { ...entry, last: Date.now() };
}
map[key] = entry;
// 'new' means Claude has never created this session, based on jsonl existence.
isNew = !sessionExists(entry.session);

// Persist atomically before printing anything.
const tmpPath = mapPath + '.tmp';
writeFileSync(tmpPath, JSON.stringify(map, null, 2), { mode: 0o600 });
renameSync(tmpPath, mapPath);

console.log(JSON.stringify({ key, session: entry.session, new: isNew, first, through, count, ...(room ? { room } : {}) }));
