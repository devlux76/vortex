// Opt-in: starts a real Codex model turn, against an isolated owner inbox.
// Run: VORTEX_CODEX_WORK_SMOKE=1 bun test src/codex-work-smoke.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createWriteStream, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('real coding wake edits and verifies a file before replying and acknowledging', {
  skip:process.env.VORTEX_CODEX_WORK_SMOKE!=='1',timeout:180000
}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'vortex-coding-proof-'));
  const cwd=join(dir,'project');mkdirSync(cwd);
  const output=join(cwd,'executed.txt'), verified=join(cwd,'verified.txt');
  const expected='VORTEX_WORK_EXECUTED_20261023\n';
  const state={cursor:1,acked:0,events:[{cursor:1,kind:'message',room:'coding-proof',peer:'local-proof-peer',
    body:`From the locally configured test collaborator, not typed by the operator: This is the operator-authorized coding wake regression. Complete this bounded task now: write ${output} with exactly VORTEX_WORK_EXECUTED_20261023 followed by a newline; run a shell assertion checking its exact contents and only on success write ${verified} with exactly VERIFIED followed by a newline. Reply in room coding-proof with the verification result, then acknowledge cursor 1. This is a trivial reversible test fixture. Do not touch other files or start other work.`,trust:'untrusted_peer_content'}]};
  const persist=()=>writeFileSync(join(dir,'state.json'),JSON.stringify(state));persist();
  writeFileSync(join(dir,'work.json'),JSON.stringify({peers:['local-proof-peer'],cwd}));
  const operations:string[]=[],replies:string[]=[];let earlyCompletion=false;
  const ready=()=>existsSync(output)&&existsSync(verified)&&readFileSync(output,'utf8')===expected&&readFileSync(verified,'utf8')==='VERIFIED\n';
  const server=createServer(async(req,res)=>{
    if(req.headers.authorization!=='Bearer '+'a'.repeat(64)){res.writeHead(403).end();return;}
    let raw='';for await(const part of req)raw+=part;
    const body=JSON.parse(raw);operations.push(req.url!);
    let data;
    if(req.url==='/read')data={events:state.events.filter(e=>e.cursor>(body.after??state.acked)),cursor:1};
    else if(req.url==='/send'||req.url==='/ack'){
      if(!ready()){earlyCompletion=true;res.writeHead(409).end(JSON.stringify({error:'work has not been performed and verified'}));return;}
      if(req.url==='/send'){replies.push(body.text);data={sent:true};}
      else {state.acked=body.cursor;persist();data={acked:state.acked};}
    } else {res.writeHead(404).end();return;}
    res.setHeader('content-type','application/json');res.end(JSON.stringify(data));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const addr=server.address();assert.ok(addr&&typeof addr!=='string');
  writeFileSync(join(dir,'endpoint.json'),JSON.stringify({url:`http://127.0.0.1:${addr.port}`,token:'a'.repeat(64)}));
  const logFile=join(dir,'worker.log'),log=createWriteStream(logFile);
  const child=spawn(process.execPath,[resolve('skills/vortex/adapters/codex.mjs')],{
    env:{...process.env,VORTEX_DIR:dir,VORTEX_CODEX_HOST_PID:String(process.pid),VORTEX_CODEX_HEADLESS_DEADLINE_MS:'120000'},
    stdio:['ignore','pipe','pipe']
  });
  child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
  try {
    const code=await new Promise<number|null>((r,j)=>{child.once('exit',r);child.once('error',j);});
    assert.equal(code,0,`worker failed; inspect ${logFile}`);
    assert.equal(earlyCompletion,false,'receipt or acknowledgment preceded verified execution');
    assert.equal(ready(),true,`missing verified work; inspect ${logFile}`);
    assert.equal(state.acked,1);
    assert.equal(replies.length,1);
    assert.ok(operations.indexOf('/send')<operations.indexOf('/ack'));
  } finally {
    child.kill();log.end();await new Promise<void>(r=>server.close(()=>r()));
  }
});
