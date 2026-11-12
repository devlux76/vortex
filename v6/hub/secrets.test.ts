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
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const rnd = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))]
// Random base62 with one digit forced in, as every real token tail has one.
const b62 = (n: number) => rnd(n).map((x, i) => i === n >> 1 ? String(x % 10) : B62[x % 62]).join('')
// A marshalled libp2p key protobuf: 08 <type> 12 <varint len> <key bytes>.
function libp2p (type: number, key: number[]): string {
  const len = key.length < 0x80 ? [key.length] : [(key.length & 0x7f) | 0x80, key.length >> 7]
  return Buffer.from([0x08, type, 0x12, ...len, ...key]).toString('base64')
}
const der = (body: number[]) => body.length < 0x80 ? [0x30, body.length, ...body] : [0x30, 0x82, body.length >> 8, body.length & 0xff, ...body]
const LIBP2P_PRIVATE: Record<string, string> = {
  ed25519: libp2p(1, rnd(64)),
  secp256k1: libp2p(2, rnd(32)),
  rsa: libp2p(0, der([0x02, 0x01, 0x00, ...rnd(1186)])),
  ecdsa: libp2p(3, der([0x02, 0x01, 0x01, ...rnd(116)])),
}
const LIBP2P_PUBLIC: Record<string, string> = {
  ed25519: libp2p(1, rnd(32)),
  secp256k1: libp2p(2, [0x02, ...rnd(32)]),
  rsa: libp2p(0, der([0x30, 0x0d, ...rnd(280)])),
  ecdsa: libp2p(3, der([0x30, 0x13, ...rnd(85)])),
}

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
  'libp2p-key': LIBP2P_PRIVATE.ed25519,
  'jwk-private-key': JSON.stringify({ crv: 'Ed25519', ['d']: mix(43), ext: true, key_ops: ['sign'], kty: 'OKP', x: mix(43) }),
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

test('A6 §1: reproduced false positives and the libp2p gap', () => {
  assert.equal(findSecret('use Bear' + 'er authentication/authorization-header here'), undefined)
  assert.equal(findSecret('pip install s' + 'k-learn-preprocessing-pipeline-configuration'), undefined)
  assert.ok(LIBP2P_PRIVATE.ed25519.startsWith('CAESQ') && LIBP2P_PRIVATE.ed25519.length === 92)
  assert.equal(findSecret(`"PrivKey": "${LIBP2P_PRIVATE.ed25519}"`), 'libp2p-key')
})

test('A6 §1: real-shaped random credentials still match', () => {
  for (let i = 0; i < 20; i++) {
    const cases: Array<[string, string]> = [
      ['openai-key', 'sk-' + b62(48)],
      ['openai-key', 'sk-' + 'proj-' + b62(64)],
      ['bearer-credential', 'Authorization: Bear' + 'er ' + b62(40)],
      ['bearer-credential', 'Bear' + 'er ' + rnd(20).map(x => x.toString(16).padStart(2, '0')).join('')],
      ['slack-token', 'xo' + 'xp-' + b62(12)],
      ['github-token', 'gh' + 'o_' + b62(36)],
      ['google-api-key', 'AI' + 'za' + b62(35)],
      ['stripe-key', 'rk' + '_live_' + b62(24)],
    ]
    for (const [kind, s] of cases) assert.equal(findSecret(`token ${s} here`), kind, kind)
  }
  for (const [type, key] of Object.entries(LIBP2P_PRIVATE)) {
    assert.equal(findSecret(`key: ${key}`), 'libp2p-key', type)
    assert.equal(findSecret(`key: ${key.replace(/\+/g, '-').replace(/\//g, '_')}`), 'libp2p-key', `${type} base64url`)
  }
  // A rejected candidate does not hide a real one later in the same text.
  assert.equal(findSecret(`s${'k-learn-preprocessing-pipeline-configuration'} then sk-${b62(48)}`), 'openai-key')
})

test('A6 §1: libp2p public keys and ordinary lines pass', () => {
  for (const [type, key] of Object.entries(LIBP2P_PUBLIC)) assert.equal(findSecret(`pub: ${key}`), undefined, type)
  for (const text of [
    'use Bear' + 'er tokens; see the authorization-header/bearer-scheme docs',
    'Bear' + 'er authentication-is-configured-per-route in the gateway',
    'see the s' + 'k-learn-wrapper-for-typescript-projects readme',
    'xo' + 'xb-token-placeholder-goes-here in the example',
    'peer 12D3KooWGzBkZy5o7dqd3BGXqE3dnzRfBoHkWn9bZ2s1VPhT8Lx3 joined',
    'CAESIENVAPLACEHOLDERVALUE is not base64 of anything useful at all',
    'git checkout -b feature/add-retry-backoff-to-the-hub-client',
    'const url = `${base}/v1/messages?since=${seq}&limit=100`',
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
