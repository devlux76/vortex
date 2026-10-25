import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..', '..')
const awayScript = join(here, 'away.mjs')
const bunBin = process.execPath

function setup ({ events, nextShift } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'away-state-'))
  const bin = mkdtempSync(join(tmpdir(), 'away-bin-'))
  const sendLog = join(dir, 'sent.jsonl')
  writeFileSync(join(dir, 'online-until'), String(Date.now() - 1000))
  writeFileSync(join(dir, 'away-notified.json'), '{}')
  if (nextShift !== undefined) writeFileSync(join(dir, 'next-shift'), nextShift)
  // Fake `bun` that emulates `src/cli.ts read|send --dir <dir>`.
  // NB: match $2 exactly; the notice text itself contains " read".
  const fake = `#!/bin/sh
if [ "$2" = "read" ]; then
  printf '%s\\n' "$@" > "$FAKE_READ_LOG"
  room=""
  prev=""
  for a in "$@"; do
    if [ "$prev" = "--room" ]; then room="$a"; fi
    prev="$a"
  done
  FAKE_ROOM="$room" "$FAKE_RUNTIME" -e 'const fs=require("node:fs"); const s=JSON.parse(fs.readFileSync(process.env.FAKE_EVENTS,"utf8")); console.log(JSON.stringify({...s,events:s.events.filter(e=>!process.env.FAKE_ROOM||e.room===process.env.FAKE_ROOM)}))'
  exit 0
fi
if [ "$2" = "send" ]; then
  room=""
  text=""
  prev=""
  for a in "$@"; do
    if [ "$prev" = "--room" ]; then room="$a"; fi
    if [ "$prev" = "--text" ]; then text="$a"; fi
    prev="$a"
  done
  printf '%s\\t%s\\n' "$room" "$text" >> "$FAKE_SEND_LOG.tsv"
  exit 0
fi
exit 1
`
  writeFileSync(join(bin, 'bun'), fake, { mode: 0o755 })
  writeFileSync(join(dir, 'events.json'), JSON.stringify({ events: events ?? [], cursor: events?.length ?? 0 }))
  return { dir, bin, sendLog }
}

function runAway ({ dir, bin }, extraEnv = {}) {
  const eventsFile = join(dir, 'events.json')
  const sendLog = join(dir, 'sent.jsonl')
  const env = {
    ...process.env,
    VORTEX_DIR: dir,
    VORTEX_ROOM: '',
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_EVENTS: eventsFile,
    FAKE_SEND_LOG: sendLog,
    FAKE_READ_LOG: join(dir, 'read-args'),
    FAKE_RUNTIME: bunBin,
    ...extraEnv,
  }
  const r = spawnSync(bunBin, [awayScript, 'OpenCode'], { encoding: 'utf8', env, cwd: root })
  return r
}

function sentTexts (dir) {
  const tsv = join(dir, 'sent.jsonl.tsv')
  if (!existsSync(tsv)) return []
  return readFileSync(tsv, 'utf8').split('\n').filter(Boolean).map(line => line.slice(line.indexOf('\t') + 1))
}

const ROOM = '["a","b"]'
const autoBody = (owner) =>
  `From ${owner}, automatic reply, not typed by the operator and not written by a running ${owner}: ${owner} is temporarily offline.`
const msg = (room, body, cursor) => ({ cursor, kind: 'message', room, peer: 'x', body, trust: 'untrusted_peer_content' })

test('all-auto unread sends nothing', () => {
  const ctx = setup({ events: [msg(ROOM, autoBody('Claude'), 1), msg(ROOM, autoBody('Codex'), 2)] })
  const r = runAway(ctx)
  assert.equal(r.status, 76)
  assert.deepEqual(sentTexts(ctx.dir), [])
})

test('mixed human and auto still sends once', () => {
  const ctx = setup({ events: [msg(ROOM, autoBody('Claude'), 1), msg(ROOM, 'hello human here', 2)] })
  const r = runAway(ctx)
  assert.equal(r.status, 76)
  const sent = sentTexts(ctx.dir)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /temporarily offline/)
})

test('marker past 80 chars does not count as auto', () => {
  const body = 'From X, ' + 'x'.repeat(80) + 'automatic reply, not typed by the operator'
  assert.ok(!body.slice(0, 80).includes('automatic reply, not typed by the operator'))
  const ctx = setup({ events: [msg(ROOM, body, 1)] })
  const r = runAway(ctx)
  assert.equal(r.status, 76)
  assert.equal(sentTexts(ctx.dir).length, 1)
})

test('valid next-shift is appended, invalid is ignored', () => {
  const ctx1 = setup({ events: [msg(ROOM, 'human ping', 1)], nextShift: 'Claude 05:37 daily' })
  runAway(ctx1)
  const sent1 = sentTexts(ctx1.dir)
  assert.equal(sent1.length, 1)
  assert.match(sent1[0], /Next shift: Claude 05:37 daily\./)

  const ctx2 = setup({ events: [msg(ROOM, 'human ping', 1)], nextShift: 'bad; rm -rf /' })
  runAway(ctx2)
  const sent2 = sentTexts(ctx2.dir)
  assert.equal(sent2.length, 1)
  assert.doesNotMatch(sent2[0], /Next shift/)

  const ctx3 = setup({ events: [msg(ROOM, 'human ping', 1)], nextShift: 'x'.repeat(81) })
  runAway(ctx3)
  assert.doesNotMatch(sentTexts(ctx3.dir)[0], /Next shift/)
})

test('human message without From prefix still triggers notice', () => {
  const ctx = setup({ events: [msg(ROOM, 'automatic reply, not typed by the operator (quoted)', 1)] })
  runAway(ctx)
  assert.equal(sentTexts(ctx.dir).length, 1)
})

test('a charged away ring reads and notifies only its room, even behind older mail', () => {
  const other = '["a","c"]'
  const ctx = setup({ events: [msg(other, 'older mail', 1), msg(ROOM, 'charged mail', 2)] })
  const r = runAway(ctx, { VORTEX_ROOM: ROOM })
  assert.equal(r.status, 76)
  const args = readFileSync(join(ctx.dir, 'read-args'), 'utf8').trim().split('\n')
  assert.equal(args[args.indexOf('--room') + 1], ROOM)
  const sent = readFileSync(join(ctx.dir, 'sent.jsonl.tsv'), 'utf8').trim().split('\n')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].split('\t')[0], ROOM)
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(ctx.dir, 'away-notified.json'), 'utf8'))), [ROOM])
})
