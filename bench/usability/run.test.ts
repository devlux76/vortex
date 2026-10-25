import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSystemPrompt, controlErrand, extractSection, isAllowedVortexArgs,
  peerIdFromAddr, runAgentLoop, runOnce, splitArgs, stripVortexPrefix, summarize, vortexRefusal,
  lfmToolCallText, makeTypedVortexTools, readReady, TYPED_VORTEX_SYSTEM, type CallModel, CONTROL_1, CONTROL_2,
} from './run.ts'

test('skill sections are read from the file at run time', () => {
  const system = buildSystemPrompt()
  assert.match(system, /invite/)
  assert.match(system, /wait/)
  assert.throws(() => extractSection('no headings', 'Meet and exchange'))
})

test('splitArgs handles quotes; vortex refuses --dir and metacharacters', () => {
  assert.deepEqual(splitArgs(`send --room '["a","b"]' --text 'hi there'`), ['send', '--room', '["a","b"]', '--text', 'hi there'])
  assert.equal(isAllowedVortexArgs('read'), true)
  assert.equal(isAllowedVortexArgs('read --dir /tmp/x'), false)
  for (const bad of ['a;b', 'a|b', 'a&b', 'a`b', 'a$b', 'a>b', 'a<b']) {
    assert.equal(isAllowedVortexArgs(bad), false, bad)
  }
})

test('vortex tool strips the skill-taught prefix and --dir pairs before checking', () => {
  assert.deepEqual(stripVortexPrefix('dial --peer /ip4/127.0.0.1/tcp/1/p2p/abc'), ['dial', '--peer', '/ip4/127.0.0.1/tcp/1/p2p/abc'])
  assert.deepEqual(
    stripVortexPrefix('bun src/cli.ts dial --peer /ip4/127.0.0.1/tcp/1/p2p/abc'),
    ['dial', '--peer', '/ip4/127.0.0.1/tcp/1/p2p/abc'])
  assert.deepEqual(
    stripVortexPrefix('dial --dir "$STATE" --peer /ip4/127.0.0.1/tcp/1/p2p/abc'),
    ['dial', '--peer', '/ip4/127.0.0.1/tcp/1/p2p/abc'])
  assert.deepEqual(
    stripVortexPrefix(`send --room '["a","b"]' --dir /tmp/x --text 'What is the code?'`),
    ['send', '--room', '["a","b"]', '--text', 'What is the code?'])
  assert.deepEqual(stripVortexPrefix('read --dir=/tmp/x'), ['read'])
  assert.deepEqual(stripVortexPrefix('read --dir'), ['read'])
  // After stripping, the remainder passes the safety check.
  assert.equal(isAllowedVortexArgs(stripVortexPrefix('bun src/cli.ts dial --dir "$STATE" --peer X').join(' ')), true)
})

test('a refusal names what was found and shows a valid example', () => {
  const msg = vortexRefusal('read; rm -rf $HOME')
  assert.match(msg, /';'/)
  assert.match(msg, /'\$'/)
  assert.match(msg, /dial --peer/)
  assert.match(vortexRefusal('read --dir /tmp/x'), /'--dir'/)
})

test('control errands name their notes', () => {
  assert.match(controlErrand(CONTROL_1), /ember/)
  assert.match(controlErrand(CONTROL_2), /harbor/)
})

// A scripted "model" that does each errand correctly by reading tool output.
function makeGoodStub (): CallModel {
  let errand = ''
  let step = 0
  let room = ''
  let cursor = 0
  let code = ''
  const lastToolOutput = (messages: any[]): string => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'tool') return String(messages[i].content)
    }
    return ''
  }
  return async (req, tools) => {
    if (req.errand !== errand) { errand = req.errand; step = 0; room = ''; cursor = 0; code = '' }
    const out = lastToolOutput(req.messages)
    if (tools[0].name === 'vortex') {
      if (step === 0) {
        const addr = req.errand.match(/\/ip4\/[^,\s]+/)?.[0]
        assert.ok(addr, 'errand carries bob multiaddr')
        step++
        return { toolCalls: [{ name: 'vortex', args: `dial --peer ${addr}` }], content: '' }
      }
      if (step === 1) {
        const addr = req.errand.match(/\/ip4\/[^,\s]+/)?.[0]!
        step++
        return { toolCalls: [{ name: 'vortex', args: `invite --peer ${peerIdFromAddr(addr)}` }], content: '' }
      }
      if (step === 2) {
        const m = out.match(/"room"\s*:\s*("(?:[^"\\]|\\.)*")/)
        room = m ? JSON.parse(m[1]) : out.trim().split('\n').find(l => l.startsWith('[')) ?? ''
        assert.ok(room, 'invite returned a room, got: ' + out.slice(0, 200))
        step++
        return { toolCalls: [{ name: 'vortex', args: 'inbox' }], content: '' }
      }
      if (step === 3) {
        // Alice can only send after bob accepts (mutual consent).
        if (/"remoteConsent": true/.test(out)) {
          step++
          return { toolCalls: [{ name: 'vortex', args: `send --room '${room}' --text 'What is the code?'` }], content: '' }
        }
        return { toolCalls: [{ name: 'vortex', args: 'inbox' }], content: '' }
      }
      if (step === 4) {
        if (/"sent": true/.test(out)) {
          step++
          return { toolCalls: [{ name: 'vortex', args: 'wait --timeout 60' }], content: '' }
        }
        // Send raced bob's accept; poll inbox then retry.
        step = 3
        return { toolCalls: [{ name: 'vortex', args: 'inbox' }], content: '' }
      }
      const found = out.match(/\b(\d{6})\b/)
      if (found) {
        code = found[1]
        const cursors = [...out.matchAll(/"cursor"\s*:\s*(\d+)/g)].map(m => Number(m[1]))
        cursor = cursors.length ? Math.max(...cursors) : cursor
        step = 99
        return { toolCalls: [{ name: 'vortex', args: `ack --cursor ${cursor}` }], content: '' }
      }
      if (step === 99) return { toolCalls: [], content: `The code is ${code}` }
      return { toolCalls: [{ name: 'vortex', args: 'wait --timeout 60' }], content: '' }
    }
    // notes controls
    const words = [...req.errand.matchAll(/'([^']+)'/g)].map(m => m[1])
    const [first, second] = words
    if (step === 0) { step++; return { toolCalls: [{ name: 'notes', args: `add ${first}` }], content: '' } }
    if (step === 1) { step++; return { toolCalls: [{ name: 'notes', args: `add ${second}` }], content: '' } }
    if (step === 2) { step++; return { toolCalls: [{ name: 'notes', args: 'list' }], content: '' } }
    if (step === 3) { step++; return { toolCalls: [{ name: 'notes', args: `delete ${first}` }], content: '' } }
    if (step === 4) { step++; return { toolCalls: [{ name: 'notes', args: 'list' }], content: '' } }
    return { toolCalls: [], content: `The remaining note is ${second}` }
  }
}

test('stubbed model completes the vortex errand and both controls', { timeout: 240000 }, async () => {
  const system = buildSystemPrompt()
  const r = await runOnce(0, makeGoodStub(), system)
  assert.deepEqual(r.vortex, { dialed: true, invited: true, sent: true, read: true, acked: true, reported: true })
  assert.deepEqual(r.control1, { added_first: true, added_second: true, listed: true, deleted: true, relisted: true, reported: true })
  assert.deepEqual(r.control2, { added_first: true, added_second: true, listed: true, deleted: true, relisted: true, reported: true })
  assert.match(summarize([r]), /vortex\.reported/)
})

test('a model that does nothing scores all false', { timeout: 240000 }, async () => {
  const noop: CallModel = async () => ({ toolCalls: [], content: 'I give up' })
  const r = await runOnce(1, noop, buildSystemPrompt())
  assert.deepEqual(r.vortex, { dialed: false, invited: false, sent: false, read: false, acked: false, reported: false })
})

test('a model that throws on the first call ends every errand with an error, never throws', { timeout: 240000 }, async () => {
  const boom: CallModel = async () => { throw new Error('first-call boom') }
  const r = await runOnce(2, boom, buildSystemPrompt())
  assert.deepEqual(r.vortex, { dialed: false, invited: false, sent: false, read: false, acked: false, reported: false })
  assert.deepEqual(r.control1, { added_first: false, added_second: false, listed: false, deleted: false, relisted: false, reported: false })
  assert.deepEqual(r.control2, { added_first: false, added_second: false, listed: false, deleted: false, relisted: false, reported: false })
  assert.match(r.error ?? '', /first-call boom/)
})

test('a model that throws mid-errand keeps the steps reached so far', { timeout: 240000 }, async () => {
  const good = makeGoodStub()
  let vortexCalls = 0
  const flaky: CallModel = async (req, tools) => {
    if (tools[0]?.name === 'vortex' && ++vortexCalls > 3) throw new Error('mid-errand boom')
    return good(req, tools)
  }
  const r = await runOnce(3, flaky, buildSystemPrompt())
  // Dial and invite completed before the throw; nothing after did.
  assert.equal(r.vortex.dialed, true)
  assert.equal(r.vortex.invited, true)
  assert.equal(r.vortex.sent, false)
  assert.equal(r.vortex.reported, false)
  // The controls use the same model but never hit the vortex-only tripwire.
  assert.deepEqual(r.control1, { added_first: true, added_second: true, listed: true, deleted: true, relisted: true, reported: true })
  assert.deepEqual(r.control2, { added_first: true, added_second: true, listed: true, deleted: true, relisted: true, reported: true })
  assert.match(r.error ?? '', /mid-errand boom/)
})

function readTranscript (dir: string, name: string): any {
  return JSON.parse(readFileSync(join(dir, name), 'utf8'))
}

test('transcript files hold system, errand, turns, answer and scores', { timeout: 240000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usability-transcript-'))
  const r = await runOnce(4, makeGoodStub(), buildSystemPrompt(), { transcriptDir: dir })
  assert.ok(r.seconds.vortex >= 0 && r.seconds.control1 >= 0 && r.seconds.control2 >= 0)
  for (const name of ['run-4-vortex.json', 'run-4-control1.json', 'run-4-control2.json']) {
    const t = readTranscript(dir, name)
    assert.match(t.system, /invite|notes/)
    assert.ok(typeof t.errand === 'string' && t.errand.length > 0)
    assert.ok(Array.isArray(t.turns) && t.turns.length > 0)
    for (const turn of t.turns) {
      assert.ok(typeof turn.assistant === 'string')
      assert.ok(Array.isArray(turn.toolCalls) && Array.isArray(turn.toolOutputs))
      assert.ok(typeof turn.requestSeconds === 'number' && turn.requestSeconds >= 0)
      for (const out of turn.toolOutputs) assert.ok(out.length <= 4000)
    }
    assert.ok(typeof t.finalAnswer === 'string' && t.finalAnswer.length > 0)
    assert.ok(t.scores && typeof t.scores === 'object')
    assert.equal(t.error, undefined)
  }
  const vortex = readTranscript(dir, 'run-4-vortex.json')
  assert.deepEqual(Object.keys(vortex.scores).sort(), ['acked', 'dialed', 'invited', 'read', 'reported', 'sent'])
  assert.ok(vortex.turns.some((t: any) => t.toolCalls.some((c: any) => c.name === 'vortex' && typeof c.args === 'string')))
})

test('a throwing model still leaves a transcript with turns so far and the error', { timeout: 240000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usability-transcript-'))
  const good = makeGoodStub()
  let vortexCalls = 0
  const flaky: CallModel = async (req, tools) => {
    if (tools[0]?.name === 'vortex' && ++vortexCalls > 3) throw new Error('mid-errand transcript boom')
    return good(req, tools)
  }
  const r = await runOnce(5, flaky, buildSystemPrompt(), { transcriptDir: dir })
  const t = readTranscript(dir, 'run-5-vortex.json')
  assert.ok(t.turns.length > 0, 'partial turns are kept')
  assert.match(t.error ?? '', /mid-errand transcript boom/)
  assert.deepEqual(t.scores, r.vortex)
  // Controls were unaffected and their files carry no error.
  assert.equal(readTranscript(dir, 'run-5-control1.json').error, undefined)
})

test('a truncated turn is retried once, then the errand recovers', async () => {
  const seen: any[][] = []
  let calls = 0
  const stub: CallModel = async (req) => {
    seen.push(req.messages)
    if (++calls === 1) {
      return { toolCalls: [], content: '', finishReason: 'length', reasoning: 'thinking about the errand at length' }
    }
    return { toolCalls: [], content: 'recovered answer' }
  }
  const r = await runAgentLoop({ system: 's', errand: 'e', tools: {}, toolDefs: [], callModel: stub })
  assert.equal(r.finalAnswer, 'recovered answer')
  assert.equal(r.truncatedTurns, 1)
  assert.equal(r.transcript.turns.length, 2)
  assert.equal(r.transcript.turns[0].truncated, true)
  assert.equal(r.transcript.turns[0].finishReason, 'length')
  assert.equal(r.transcript.turns[0].reasoning, 'thinking about the errand at length')
  assert.equal(r.transcript.turns[1].truncated, false)
  // The retry carries the cut-off note, and reasoning is never sent back.
  const retry = seen[1].map((m: any) => JSON.stringify(m).slice(0, 4000))
  assert.ok(retry.some((m: string) => m.includes('cut off')), 'retry note present')
  assert.ok(retry.every((m: string) => !m.includes('thinking about the errand')), 'no reasoning in history')
})

test('two truncated turns end the errand as now', async () => {
  const stub: CallModel = async () => ({ toolCalls: [], content: '', finishReason: 'length', reasoning: 'more thinking' })
  const r = await runAgentLoop({ system: 's', errand: 'e', tools: {}, toolDefs: [], callModel: stub })
  assert.equal(r.finalAnswer, '')
  assert.equal(r.truncatedTurns, 2)
  assert.equal(r.transcript.turns.length, 2)
  assert.ok(r.transcript.turns.every(t => t.truncated))
})

// The same scripted model, speaking the typed tools: each of its command
// strings becomes one function call with named JSON arguments.
function makeTypedStub (): CallModel {
  const inner = makeGoodStub()
  const flags = (tokens: string[]) => Object.fromEntries(tokens.flatMap((t, i) => t.startsWith('--') ? [[t.slice(2), tokens[i + 1]]] : []))
  return async (req, tools) => {
    const vortex = tools.some(t => t.name === 'dial')
    const res = await inner(req, [{ name: vortex ? 'vortex' : 'notes', description: '', usage: '' }])
    return {
      ...res,
      toolCalls: res.toolCalls.map(c => {
        const [verb, ...rest] = splitArgs(c.args)
        if (vortex) {
          const { timeout: _t, room: _r, ...named } = flags(rest)
          if (verb === 'send') named.peer = peerIdFromAddr(req.errand.match(/\/ip4\/[^,\s]+/)![0])
          return { name: verb, args: JSON.stringify(named) }
        }
        return verb === 'list' ? { name: 'list_notes', args: '{}' } : { name: `${verb}_note`, args: JSON.stringify({ text: rest.join(' ') }) }
      }),
    }
  }
}

test('typed tools: stubbed model completes the vortex errand and both controls', { timeout: 240000 }, async () => {
  const r = await runOnce(0, makeTypedStub(), TYPED_VORTEX_SYSTEM, { typedTools: true })
  assert.equal(r.error, undefined)
  assert.deepEqual(r.vortex, { dialed: true, invited: true, sent: true, read: true, acked: true, reported: true })
  assert.deepEqual(r.control1, { added_first: true, added_second: true, listed: true, deleted: true, relisted: true, reported: true })
  assert.deepEqual(r.control2, { added_first: true, added_second: true, listed: true, deleted: true, relisted: true, reported: true })
})

test('typed tools name a missing argument instead of running the command', async () => {
  const tools = makeTypedVortexTools('/nonexistent', [])
  assert.match(await tools.send('{"peer":"p"}'), /missing argument: text/)
  assert.match(await tools.dial('not json'), /must be a JSON object/)
})

test('a past tool call is written in the LFM2.5 text form', () => {
  const typed = (name: string) => name !== 'vortex'
  assert.equal(lfmToolCallText([{ name: 'add_note', args: '{"text":"ember"}' }], typed),
    '<|tool_call_start|>[add_note(text="ember")]<|tool_call_end|>')
  assert.equal(lfmToolCallText([{ name: 'wait', args: '{}' }, { name: 'vortex', args: 'read' }], typed),
    '<|tool_call_start|>[wait(), vortex(args="read")]<|tool_call_end|>')
})

// A model that plans ahead: it sends straight after inviting, without checking
// that the peer accepted, and acks without naming a cursor.
test('typed tools: send right after invite waits for the acceptance; ack needs no cursor', { timeout: 240000 }, async () => {
  let step = 0
  let code = ''
  const stub: CallModel = async (req, tools) => {
    if (!tools.some(t => t.name === 'dial')) return { toolCalls: [], content: '' }
    const addr = req.errand.match(/\/ip4\/[^,\s]+/)![0]
    const out = [...req.messages].reverse().find(m => m.role === 'tool')?.content ?? ''
    const call = (name: string, args: object) => ({ toolCalls: [{ name, args: JSON.stringify(args) }], content: '' })
    if (step === 0) { step++; return call('dial', { peer: addr }) }
    if (step === 1) { step++; return call('invite', { peer: peerIdFromAddr(addr) }) }
    if (step === 2) { step++; return call('send', { peer: peerIdFromAddr(addr), text: 'What is the code?' }) }
    if (step === 3) {
      const found = String(out).match(/\b(\d{6})\b/)
      if (!found) return call('wait', {})
      code = found[1]; step++
      return call('ack', {})
    }
    return { toolCalls: [], content: `The code is ${code}` }
  }
  const r = await runOnce(0, stub, TYPED_VORTEX_SYSTEM, { typedTools: true })
  assert.equal(r.error, undefined)
  assert.deepEqual(r.vortex, { dialed: true, invited: true, sent: true, read: true, acked: true, reported: true })
  // One wait is enough: it does not return on the acceptance alone.
  assert.equal(r.vortexCalls, 5)
})

test('a service that takes longer than a second to report ready is still seen', async () => {
  const proc = Bun.spawn(['bun', '-e', 'await Bun.sleep(1500); console.log(JSON.stringify({ event: "ready", peerId: "p", addrs: [] })); await Bun.sleep(5000)'], { stdout: 'pipe' })
  try {
    const ready = await readReady(proc, 8000)
    assert.equal(ready.peerId, 'p')
  } finally { proc.kill() }
})
