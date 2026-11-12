// A6 (docs/v6-amendment-a6-secrets.md): outbound credential screen and its
// operator-visible tally. Fake credentials are assembled at run time so this
// file contains no credential-shaped literal of its own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHub } from './main.ts'
import { findSecret, SECRET_KINDS } from './secrets.ts'

const r = (n: number, ch = 'A') => ch.repeat(n)
const mix = (n: number) => 'aB3_x9Z-'.repeat(Math.ceil(n / 8)).slice(0, n)

const SAMPLES: Record<string, string> = {
  'vortex-token': 'vt' + '_' + mix(43),
  'private-key': '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----\nb3Blbn==\n',
  'aws-access-key': 'AK' + 'IA' + r(16, 'Q'),
  'github-token': 'gh' + 'p_' + r(36, 'k'),
  'anthropic-key': 'sk-' + 'ant-' + mix(40),
  'openai-key': 'sk-' + 'proj-' + mix(48),
  'slack-token': 'xo' + 'xb-' + '1234567890-abcdef',
  'google-api-key': 'AI' + 'za' + mix(35),
  'stripe-key': 'sk' + '_live_' + r(24, 'z'),
  jwt: 'ey' + 'J' + mix(20) + '.ey' + 'J' + mix(20) + '.' + mix(20),
  'bearer-credential': 'Authorization: Bear' + 'er ' + mix(32),
}

test('A6 §1: every listed credential shape is found, inside ordinary text', () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), [...SECRET_KINDS].sort())
  for (const [kind, sample] of Object.entries(SAMPLES)) {
    assert.equal(findSecret(`here you go: ${sample} — thanks`), kind, kind)
  }
})

test('A6 §1: ordinary prose, code and placeholders pass', () => {
  for (const text of [
    'can you check the hub test?',
    'set Authorization: Bearer <token> from the env var',
    'the key looks like sk-... and lives in ~/.config/vortex/claude.json',
    'tokens start with vt_ followed by 43 base64url characters',
    'const task = ask("deploy"); // risk-assessment and desk-ant-farm notes',
    'see -----BEGIN CERTIFICATE----- in the pinned cert',
    'commit 89bfca9a1b2c3d4e5f60718293a4b5c6d7e8f901 fixed it',
    'uuid 0f8fad5b-d9cb-469f-a165-70867728950e and ULID 01JC8ZQ2K4M9V7X0R5T3N6P1BW',
  ]) assert.equal(findSecret(text), undefined, text)
})

async function setup () {
  const dir = mkdtempSync(join(tmpdir(), 'vx-a6-'))
  const hub = await startHub({ stateDir: join(dir, 'state'), configDir: join(dir, 'config'), cfg: { listen: '127.0.0.1:0', sendPerMinute: 2 } })
  const tokens: Record<string, string> = {}
  for (const p of ['alice', 'bob']) tokens[p] = hub.store.createPrincipal(p).token
  tokens.operator = (await Bun.file(join(dir, 'config', 'vortex', 'operator.json')).json()).token
  const base = `http://127.0.0.1:${hub.port}`
  const call = (method: string, path: string, who: string, body?: unknown) => fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { hub, tokens, call, stop: async () => { await hub.stop(); rmSync(dir, { recursive: true, force: true }) } }
}

test('A6 §1–2: a credential-shaped send is refused before storage and rate counting, and the operator sees it', async () => {
  const e = await setup()
  const quiet = console.error
  console.error = () => {}
  try {
    const head = e.hub.store.seqHead()
    // The sender's own hub token, the most direct impersonation path.
    const refused = await e.call('POST', '/v1/messages', 'alice', { scope: 'dm', to: ['bob'], text: `sure, it is ${e.tokens.alice}` })
    assert.equal(refused.status, 422)
    const err = (await refused.json()).error as string
    assert.match(err, /vortex-token/)
    assert.ok(!err.includes(e.tokens.alice), 'refusal never echoes the credential')
    const op = await e.call('POST', '/v1/messages', 'operator', { text: `key ${SAMPLES['github-token']}` })
    assert.equal(op.status, 422, 'the operator is screened too')
    assert.equal(e.hub.store.seqHead(), head, 'nothing stored, no seq advanced')

    // Refusals took no send-rate slot: sendPerMinute is 2 and both still pass.
    for (const text of ['first', 'second']) assert.equal((await e.call('POST', '/v1/messages', 'alice', { text })).status, 200)

    const opStatus = await (await e.call('GET', '/v1/status', 'operator')).json()
    assert.deepEqual(opStatus.refusedSecrets.map((x: any) => [x.principal, x.count, x.lastKind]),
      [['alice', 1, 'vortex-token'], ['operator', 1, 'github-token']])
    assert.ok(!JSON.stringify(opStatus).includes(e.tokens.alice))
    const bobStatus = await (await e.call('GET', '/v1/status', 'bob')).json()
    assert.deepEqual(bobStatus.refusedSecrets, [], 'a peer sees only its own refusals')
    const aliceStatus = await (await e.call('GET', '/v1/status', 'alice')).json()
    assert.deepEqual(aliceStatus.refusedSecrets.map((x: any) => x.principal), ['alice'])
  } finally {
    console.error = quiet
    await e.stop()
  }
})
