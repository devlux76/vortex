// Docs: skills/vortex/SKILL.md — Meet and exchange (CLI arguments and actionable refusals).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

declare const Bun: any;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function runCli (args: string[]): Promise<{ exit: number | null, json: any, raw: string }> {
  const proc: any = Bun.spawn(['bun', 'src/cli.ts', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
  const done = proc.exited
  const timeout = new Promise<never>((_, reject) => setTimeout(() => {
    try { proc.kill('SIGTERM') } catch { /* ignore */ }
    reject(new Error('cli timed out: ' + args.join(' ')))
  }, 30000))
  await Promise.race([done, timeout])
  const raw = (await new Response(proc.stdout).text()).trim()
  return { exit: proc.exitCode, json: JSON.parse(raw), raw }
}

const cases: { args: string[], error: RegExp, got?: string }[] = [
  { args: ['dial'], error: /--peer is missing/ },
  { args: ['dial', '--peer', 'not a peer!!'], error: /--peer is neither a peer id nor a valid multiaddr/, got: 'not a peer!!' },
  { args: ['dial', '--peer', '/ip4/127.0.0.1/tcp/1/p2p/12D3KooWAbcj7K")'], error: /extra characters after the peer id: '"\)'/ },
  { args: ['dial', '--peer', '/ip4/127.0.0.1/tcp/1'], error: /does not end in \/p2p/ },
  { args: ['invite'], error: /--peer is missing/ },
  { args: ['invite', '--peer', 'xyz'], error: /--peer is neither/ },
  { args: ['send', '--text', 'hi'], error: /--room is missing/ },
  { args: ['send', '--room', 'nope', '--text', 'hi'], error: /--room is not valid JSON/, got: 'nope' },
  { args: ['send', '--room', '["only-one"]', '--text', 'hi'], error: /must be a JSON array of two peer ids/ },
  { args: ['send', '--room', '["a","b"]'], error: /--text is missing/ },
  { args: ['accept'], error: /--room is missing/ },
  { args: ['accept', '--room', '{bad json'], error: /--room is not valid JSON/ },
  { args: ['ack'], error: /--cursor is missing/ },
  { args: ['ack', '--cursor', 'abc'], error: /--cursor must be a number/, got: 'abc' },
  { args: ['announce'], error: /--statement for a semantic announcement or --text for a legacy interest/ },
  { args: ['announce', '--text', 'hi', '--statement', 'x'], error: /either --statement or --text, not both/, got: 'x' },
  { args: ['announce', '--statement', 'x', '--ttl', '0'], error: /--ttl must be an integer from 1 to 3600/, got: '0' },
  { args: ['announce', '--statement', 'x', '--ttl', '3601'], error: /--ttl must be an integer from 1 to 3600/, got: '3601' },
  { args: ['announce', '--statement', 'x', '--ttl', 'abc'], error: /--ttl must be an integer from 1 to 3600/, got: 'abc' },
  { args: ['announce', '--statement', 'x', '--replaces', 'zzz'], error: /--replaces must be 32 lowercase/, got: 'zzz' },
  { args: ['withdraw'], error: /--id is missing/ },
  { args: ['withdraw', '--id', 'xyz'], error: /--id must be 32 lowercase/, got: 'xyz' },
  { args: ['matches'], error: /--id is missing/ },
  { args: ['matches', '--id', 'A'.repeat(32)], error: /--id must be 32 lowercase/, got: 'A'.repeat(32) },
  { args: ['create'], error: /--statement is missing/ },
  { args: ['create', '--statement', 'topic', '--capacity', '1'], error: /--capacity must/, got: '1' },
  { args: ['create', '--statement', 'topic', '--admission', 'unknown'], error: /--admission must/, got: 'unknown' },
  { args: ['create', '--statement', 'topic', '--admission-peer', 'bad'], error: /--admission-peer/ },
  { args: ['join'], error: /--ref is missing/ },
  { args: ['join', '--ref', 'A'.repeat(32)], error: /--ref must be 32 lowercase/, got: 'A'.repeat(32) },
  { args: ['post'], error: /--conference is missing/ },
  { args: ['post', '--conference', 'xyz', '--text', 'hi'], error: /--conference must be 32 lowercase/, got: 'xyz' },
  { args: ['post', '--conference', 'a'.repeat(32)], error: /--text is missing/ },
  { args: ['post', '--conference', 'a'.repeat(32), '--text', 'hi', '--type', 'Bad'], error: /--type must/, got: 'Bad' },
  { args: ['post', '--conference', 'a'.repeat(32), '--text', 'hi', '--type', ''], error: /--type must/, got: '' },
  { args: ['post', '--conference', 'a'.repeat(32), '--text', 'hi', '--type', 'a'.repeat(33)], error: /--type must/ },
  { args: ['post', '--conference', 'a'.repeat(32), '--text', 'hi', '--reply-to', 'z'.repeat(32)], error: /--reply-to must be 32 lowercase/, got: 'z'.repeat(32) },
  { args: ['history'], error: /--conference is missing/ },
  { args: ['history', '--conference', 'a'.repeat(32), '--limit', '21'], error: /--limit must/, got: '21' },
  { args: ['history', '--conference', 'a'.repeat(32), '--after=-1'], error: /--after must/, got: '-1' },
  { args: ['leave'], error: /--conference is missing/ },
  { args: ['leave', '--conference', 'bad'], error: /--conference must be 32 lowercase/, got: 'bad' },
]

test('argument errors reply with JSON naming the flag, the value, and an example', { timeout: 180000 }, async () => {
  for (const c of cases) {
    const r = await runCli(c.args)
    assert.notEqual(r.exit, 0, `${c.args.join(' ')} must exit non-zero`)
    assert.match(r.json.error, c.error, `${c.args.join(' ')}: ${r.raw}`)
    assert.ok(typeof r.json.example === 'string' && r.json.example.includes('bun src/cli.ts'), `${c.args.join(' ')}: example missing`)
    assert.ok(typeof r.json.got === 'string' && r.json.got.length <= 200, `${c.args.join(' ')}: got missing`)
    if (c.got !== undefined) assert.equal(r.json.got, c.got)
  }
})

// Docs: ISSUES.md I12; VORTEX_v5.1.md section 9.3
test('nudge is an accepted operation and needs no arguments', { timeout: 60000 }, async () => {
  const proc: any = Bun.spawn(['bun', 'src/cli.ts', 'nudge', '--dir', resolve(ROOT, 'does-not-exist')],
    { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
  await proc.exited
  assert.notEqual(proc.exitCode, 0)
  const raw = (await new Response(proc.stdout).text()).trim()
  assert.ok(!raw.includes('<serve|info'), `must not be a usage error: ${raw}`)
})

// Docs: VORTEX_v5.1.md section 9.1
test('valid semantic flags pass validation and fail only on the missing server', { timeout: 60000 }, async () => {
  const proc: any = Bun.spawn(['bun', 'src/cli.ts', 'announce', '--statement', 'x', '--ttl', '60',
    '--publish-statement', '--dir', resolve(ROOT, 'does-not-exist')],
    { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
  await proc.exited
  assert.notEqual(proc.exitCode, 0)
  const raw = (await new Response(proc.stdout).text()).trim()
  assert.ok(!raw.includes('"error"'), `must not be a validation error: ${raw}`)
})

// Docs: VORTEX_v5.1.md section 9.1
test('valid conference operations pass validation and reach the missing server', { timeout: 60000 }, async () => {
  for (const args of [['join','--ref','a'.repeat(32),'--session','s'],
    ['post','--conference','a'.repeat(32),'--text','hi','--type','text','--reply-to','b'.repeat(32)],
    ['history','--conference','a'.repeat(32),'--session','s','--limit','1','--after','0'],
    ['leave','--conference','a'.repeat(32)],['conferences','--session','s']]) {
    const proc: any = Bun.spawn(['bun','src/cli.ts',...args,'--dir',resolve(ROOT,'does-not-exist')],
      {cwd:ROOT,stdout:'pipe',stderr:'pipe'});
    await proc.exited;
    const stdout=await new Response(proc.stdout).text();
    const raw=stdout+(await new Response(proc.stderr).text());
    assert.notEqual(proc.exitCode,0);
    assert.equal(stdout.trim(),'',raw);
    assert.match(raw,/ENOENT/);
  }
})
