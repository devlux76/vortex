// Fixed away reply, only dispatched when the owner has no line or live host.
// No model, no acknowledgment, and no presence lease.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const owner = process.argv[2];
const dir = process.env.VORTEX_DIR;
if (!owner || !dir) process.exit(1);
const epochFile = join(dir, 'presence-epoch');
const epoch = existsSync(epochFile) ? readFileSync(epochFile, 'utf8') : '';

const cli = (...args) => spawnSync('bun', ['src/cli.ts', ...args, '--dir', dir], { encoding: 'utf8' });
const NOTICE = `From ${owner}, automatic reply, not typed by the operator and not written by a running ${owner}: ` +
  `${owner} is temporarily offline to save usage and has not read your message. It is stored and will be read ` +
  `when a ${owner} session next starts. Do not wait for ${owner}; carry on with what you can do without it.`;
const EVERY_MS = 6 * 60 * 60 * 1000;
const AUTO_MARK = 'automatic reply, not typed by the operator';
const isAutoReply = (body) =>
  typeof body === 'string' && body.startsWith('From ') && body.slice(0, 80).includes(AUTO_MARK);

let notice = NOTICE;
try {
  const shiftFile = join(dir, 'next-shift');
  if (existsSync(shiftFile)) {
    const content = readFileSync(shiftFile, 'utf8').trim();
    if (content.length > 0 && content.length <= 80 && /^[A-Za-z0-9 :.\-]+$/.test(content)) {
      notice += ` Next shift: ${content}.`;
    }
  }
} catch {
  /* A bad next-shift file is ignored; the fixed notice still goes out. */
}

const stampFile = join(dir, 'away-notified.json');
const stamps = existsSync(stampFile) ? JSON.parse(readFileSync(stampFile, 'utf8')) : {};
// An unattended ring may spend only the room the router charged. Manual
// invocations without a charged room retain the all-room offline notice.
const room = process.env.VORTEX_ROOM;
const read = cli('read', ...(room ? ['--room', room] : []));
if (read.status !== 0) process.exit(1);
const unread = JSON.parse(read.stdout).events.filter(e => e.kind === 'message');
const byRoom = new Map();
for (const e of unread) {
  if (!byRoom.has(e.room)) byRoom.set(e.room, []);
  byRoom.get(e.room).push(e);
}
for (const [room, list] of byRoom) {
  // An away notice must not trigger the other side's away notice: if every
  // unread body in the room is itself an automatic reply, send nothing.
  if (list.length > 0 && list.every(e => isAutoReply(e.body))) continue;
  // An actual attachment resets the absence, without a clock-based lease.
  const saved = stamps[room];
  const stamp = typeof saved === 'number' ? {at:saved,epoch:''} : saved;
  if (stamp?.epoch === epoch && stamp.at > Date.now() - EVERY_MS) continue;
  if (cli('send', '--room', room, '--text', notice).status === 0) stamps[room] = {at: Date.now(), epoch};
}
writeFileSync(stampFile, JSON.stringify(stamps));
process.exit(76);
