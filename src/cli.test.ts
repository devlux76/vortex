import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { createMcpHandler, protocolVersion } from './mcp-protocol.ts';

import {  } from './cli.testkit.ts'

test('local API waits for delivery, persists ack, and runs one local wake adapter', {timeout:20000}, async () => {
  const root=mkdtempSync(join(tmpdir(),'vortex-cli-test-'));
  const processes:ChildProcess[]=[];
  const log=join(root,'rings');
  const routerSocket=join(root,'router','router.sock');
  const adapter=join(root,'wake.sh');
  writeFileSync(adapter,`#!/bin/sh\nprintf '%s %s\\n' "$VORTEX_DIR" "$VORTEX_UNREAD" >> '${log}'\nsleep 2\n`,{mode:0o700});
  const start=async (name:string,onRing?:string) => {
    const dir=join(root,name);
    if(existsSync(join(dir,'endpoint.json'))) unlinkSync(join(dir,'endpoint.json'));
    const child=spawn('bun',['src/cli.ts','serve','--dir',dir,'--name',name,'--port','0','--ring-quiet-ms','0','--backbone',routerSocket,...(onRing?['--on-ring',onRing]:[])],{stdio:'ignore'});
    processes.push(child);
    const end=Date.now()+5000;
    while(!existsSync(join(dir,'endpoint.json'))) {
      if(child.exitCode!==null || Date.now()>end) throw new Error('test service did not start');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const endpoint=JSON.parse(readFileSync(join(dir,'endpoint.json'),'utf8'));
    const call=async(op:string,args:unknown={},signal?:AbortSignal) => {
      const response=await fetch(endpoint.url+'/'+op,{method:'POST',headers:{authorization:'Bearer '+endpoint.token,'content-type':'application/json'},body:JSON.stringify(args),signal});
      const result=await response.json() as any;
      if(!response.ok) throw new Error(result.error);
      return result;
    };
    return {dir,child,call};
  };
  try {
    const build=spawnSync('mix',['escript.build'],{cwd:resolve('backbone'),encoding:'utf8'});
    assert.equal(build.status,0,build.stdout+build.stderr);
    const router=spawn(resolve('backbone/vortex_router'),['--socket',routerSocket,'--min-interval-ms','0'],{stdio:'ignore'});
    processes.push(router);
    const ready=Date.now()+5000;
    while(!existsSync(routerSocket)) {
      if(router.exitCode!==null || Date.now()>ready) throw Error('OTP router did not start');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    let a=await start('a');
    const b=await start('b');
    const ai=await a.call('info'), bi=await b.call('info');
    await a.call('dial',{peer:bi.addrs[0]});
    const {room}=await a.call('invite',{peer:bi.peerId});
    await b.call('wait',{timeout:2});
    await b.call('accept',{room});
    const accepted=await a.call('wait',{timeout:2});
    await a.call('ack',{cursor:accepted.cursor});
    assert.deepEqual((await a.call('read')).events,[]);
    for(const text of ['x'.repeat(16384),'é'.repeat(8192),'\\"'.repeat(8192),'\u0000'.repeat(16384)]) {
      await a.call('send',{room,text});
      const page=await b.call('wait',{timeout:2}).catch(error=>{throw Error(`delivery failed for ${JSON.stringify(text.slice(0,2))}: ${error.message}`);});
      assert.equal(page.events.at(-1).body,text);
      await b.call('ack',{cursor:page.cursor});
    }
    await assert.rejects(a.call('send',{room,text:'x'.repeat(16385)}),/bytes/);
    a.child.kill('SIGTERM');
    await new Promise<void>(resolve=>a.child.once('exit',()=>resolve()));
    a=await start('a',adapter);
    const restartedInfo=await a.call('info');
    await b.call('dial',{peer:restartedInfo.addrs[0]});
    const waiting=a.call('wait',{timeout:2});
    await new Promise(resolve=>setTimeout(resolve,50));
    await b.call('send',{room,text:'wake via pending wait'});
    const page=await waiting;
    assert.equal(page.events[0].body,'wake via pending wait');
    await a.call('ack',{cursor:page.cursor});
    assert.equal(existsSync(log),false);
    await assert.rejects(a.call('ack',{cursor:page.cursor-1}),/cursor/);
    await assert.rejects(a.call('wait',{timeout:0.01}),/timed out/);
    const controller=new AbortController();
    const canceled=a.call('wait',{timeout:2},controller.signal);
    await new Promise(resolve=>setTimeout(resolve,50));
    controller.abort();
    await assert.rejects(canceled);
    await new Promise(resolve=>setTimeout(resolve,50));
    await b.call('send',{room,text:'wake while idle'});
    const end=Date.now()+3000;
    while(!existsSync(log)) {
      if(Date.now()>end) throw new Error('local wake adapter did not run');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    await b.call('send',{room,text:'coalesce another event'});
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(readFileSync(log,'utf8').trim().split('\n').length,1);
    assert.ok(readFileSync(log,'utf8').startsWith(a.dir+' '));
    const stored=await a.call('read');
    await a.call('ack',{cursor:stored.cursor});
    a.child.kill('SIGTERM');
    await new Promise<void>(resolve=>a.child.once('exit',()=>resolve()));
    const restored=await start('a');
    assert.equal((await restored.call('info')).peerId,ai.peerId);
    assert.deepEqual((await restored.call('read')).events,[]);
  } finally {
    await Promise.all(processes.filter(p=>p.exitCode===null&&p.signalCode===null).map(p=>new Promise<void>(resolve=>{p.once('exit',()=>resolve());p.kill('SIGTERM');})));
    rmSync(root,{recursive:true,force:true});
  }
});

// Docs: VORTEX_v5.1.md section 9.1
test('semantic mode reports its namespace and answers discovery calls without loading the model', {timeout:60000}, async () => {
  const root=mkdtempSync(join(tmpdir(),'vortex-cli-semantic-'));
  const processes:ChildProcess[]=[];
  const forbid={VORTEX_TEST_FORBID_MODEL_LOAD:'1'};
  const policyFile=join(root,'policy.json');
  writeFileSync(policyFile,JSON.stringify({blockedProjectIds:['sensitive-marker']}));
  const run=(args:string[]) => {
    const r=spawnSync('bun',['src/cli.ts',...args],{encoding:'utf8',timeout:30000});
    return {exit:r.status,json:JSON.parse(r.stdout.trim()||'null') as any,raw:r.stdout+r.stderr};
  };
  const start=async (name:string,extra:string[]) => {
    const dir=join(root,name);
    mkdirSync(dir,{recursive:true});
    if(name==='sem') writeFileSync(join(dir,'state.json'),JSON.stringify({rooms:{},seen:[],cursor:1,events:[{
      cursor:1,kind:'conference_message',room:'conference:'+'a'.repeat(32),conference:'a'.repeat(32),
      session:'default',peer:'peer',body:'stored conference post',trust:'untrusted_peer_content'
    }]}));
    if(existsSync(join(dir,'endpoint.json'))) unlinkSync(join(dir,'endpoint.json'));
    const child=spawn('bun',['src/cli.ts','serve','--dir',dir,'--name',name,'--port','0',...extra],
      {stdio:'ignore',env:{...process.env,...forbid}});
    processes.push(child);
    const end=Date.now()+8000;
    while(!existsSync(join(dir,'endpoint.json'))) {
      if(child.exitCode!==null || Date.now()>end) throw new Error('test service did not start');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    return {dir,child};
  };
  try {
    const sem=await start('sem',['--semantic','--history-limit','0','--dedup-limit','1','--conference-history-limit','2','--conference-history-bytes','8192','--disclosure-policy',policyFile]);
    const info=run(['info','--dir',sem.dir]);
    assert.equal(info.exit,0,info.raw);
    assert.equal(info.json.semantic.enabled,true);
    assert.match(info.json.semantic.namespace,/^[0-9a-f]{64}$/);
    assert.ok(info.json.wake!==undefined,'wake block preserved');
    assert.deepEqual(info.json.disclosure,{configured:true});
    for(const [op,flag] of [['announce','--statement'],['announce','--text'],['create','--statement']]) {
      const refused=run([op,flag,'sensitive-marker','--dir',sem.dir]);
      assert.notEqual(refused.exit,0);
      assert.match(refused.json.error,/disclosure policy refused: project identifier/);
      assert.ok(!refused.raw.includes('sensitive-marker'));
    }
    const creating=run(['create','--statement','public topic','--session','creator','--capacity','3',
      '--admission','group','--admission-peer',info.json.peerId,'--dir',sem.dir]);
    assert.notEqual(creating.exit,0);
    assert.match(creating.json.error,/model load forbidden/);
    const endpoint=JSON.parse(readFileSync(join(sem.dir,'endpoint.json'),'utf8'));
    const invalid=await fetch(endpoint.url+'/create',{method:'POST',headers:{authorization:'Bearer '+endpoint.token,
      'content-type':'application/json'},body:JSON.stringify({session:'creator',statement:'public topic',capacity:2.5})});
    assert.equal(invalid.status,400);
    assert.match((await invalid.json() as any).error,/capacity/);
    const interests=run(['interests','--dir',sem.dir]);
    assert.equal(interests.exit,0,interests.raw);
    assert.deepEqual(interests.json,{interests:[]});
    const matches=run(['matches','--dir',sem.dir,'--id','b'.repeat(32)]);
    assert.equal(matches.exit,0,matches.raw);
    assert.deepEqual(matches.json.matches,[]);
    const withdrawn=run(['withdraw','--dir',sem.dir,'--id','b'.repeat(32)]);
    assert.equal(withdrawn.exit,0,withdrawn.raw);
    assert.deepEqual(withdrawn.json,{withdrawn:false});
    const conferences=run(['conferences','--dir',sem.dir]);
    assert.equal(conferences.exit,0,conferences.raw);
    assert.deepEqual(conferences.json,{conferences:[]});
    const unknownHistory=run(['history','--conference','b'.repeat(32),'--session','default','--limit','1','--after','0','--dir',sem.dir]);
    assert.notEqual(unknownHistory.exit,0);
    assert.match(unknownHistory.json.error,/not in this conference/);
    const waited=run(['wait','--for','message','--timeout','1','--dir',sem.dir]);
    assert.equal(waited.exit,0,waited.raw);
    assert.equal(waited.json.events[0].kind,'conference_message');
    // Docs: VORTEX_v5.1.md §8.3. Serve limits reach durable storage through the local API.
    const acked=run(['ack','--cursor',String(waited.json.cursor),'--dir',sem.dir]);
    assert.equal(acked.exit,0,acked.raw);
    const history=run(['read','--after','0','--dir',sem.dir]);
    assert.equal(history.exit,0,history.raw);
    assert.deepEqual(history.json.events,[]);
    assert.equal(JSON.parse(readFileSync(join(sem.dir,'state.json'),'utf8')).cursor,1);
    const joined=run(['join','--ref','b'.repeat(32),'--dir',sem.dir]);
    assert.notEqual(joined.exit,0);
    assert.match(joined.json.error,/no match with that record/);
    const posted=run(['post','--conference','b'.repeat(32),'--text','hi','--dir',sem.dir]);
    assert.notEqual(posted.exit,0);
    assert.match(posted.json.error,/not in this conference/);
    const left=run(['leave','--conference','b'.repeat(32),'--dir',sem.dir]);
    assert.equal(left.exit,0,left.raw);
    assert.deepEqual(left.json,{left:false});
    const plain=await start('plain',[]);
    const plainInfo=run(['info','--dir',plain.dir]);
    assert.equal(plainInfo.exit,0,plainInfo.raw);
    assert.deepEqual(plainInfo.json.semantic,{enabled:false});
    assert.deepEqual(plainInfo.json.wake,{configured:false,adapter:null,rings:false,refusedRings:0,routerConnected:false,adapterRunning:false,lastExitCode:null});
    assert.deepEqual(plainInfo.json.disclosure,{configured:false});
    const deniedCreate=run(['create','--statement','public topic','--dir',plain.dir]);
    assert.notEqual(deniedCreate.exit,0);
    assert.match(deniedCreate.json.error,/not enabled/);
    const deniedConferences=run(['conferences','--dir',plain.dir]);
    assert.notEqual(deniedConferences.exit,0);
    assert.match(deniedConferences.json.error,/not enabled/);
    const denied=run(['interests','--dir',plain.dir]);
    assert.notEqual(denied.exit,0);
    assert.match(denied.json.error,/not enabled/);
  } finally {
    await Promise.all(processes.filter(p=>p.exitCode===null&&p.signalCode===null).map(p=>new Promise<void>(resolve=>{p.once('exit',()=>resolve());p.kill('SIGTERM');})));
    rmSync(root,{recursive:true,force:true});
  }
});

// Docs: ISSUES.md I12; VORTEX_v5.1.md section 9.3
test('nudge ends a pending wait at once with nudged true', {timeout:60000}, async () => {
  const root=mkdtempSync(join(tmpdir(),'vortex-cli-nudge-'));
  const processes:ChildProcess[]=[];
  const nudge=(): number => {
    const r=spawnSync('bun',['src/cli.ts','nudge','--dir',join(root,'n')],{encoding:'utf8',timeout:10000});
    assert.equal(r.status,0,r.stderr.toString());
    const printed=JSON.parse(r.stdout.toString());
    assert.deepEqual(Object.keys(printed),['nudged']);
    return printed.nudged;
  };
  const startWait=(extra:string[]) => {
    const child=spawn('bun',['src/cli.ts','wait','--dir',join(root,'n'),'--timeout','60',...extra],
      {stdio:['ignore','pipe','pipe']});
    processes.push(child);
    let out='';
    child.stdout?.on('data',chunk=>{out+=chunk.toString();});
    return {child,out:()=>out};
  };
  const release=(waiting:{child:ChildProcess,out:()=>string}) => {
    // No fixed sleep for attach: nudge until the waiter is seen, at most 50 tries.
    let released=0;
    for(let i=0;i<50 && released!==1;i++) {
      released=nudge();
      if(released!==1) spawnSync('sleep',['0.1']);
    }
    assert.equal(released,1,'a nudge reached the pending wait');
    return waiting;
  };
  const dir=join(root,'n');
  const child=spawn('bun',['src/cli.ts','serve','--dir',dir,'--name','n','--port','0'],{stdio:'ignore'});
  processes.push(child);
  try {
    const end=Date.now()+8000;
    while(!existsSync(join(dir,'endpoint.json'))) {
      if(child.exitCode!==null || Date.now()>end) throw new Error('test service did not start');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const waiting=release(startWait([]));
    const exited=new Promise<void>((resolve,reject) => {
      const timer=setTimeout(()=>reject(new Error('wait did not end within 3 s of the nudge')),3000);
      waiting.child.once('exit',code=>{clearTimeout(timer);assert.equal(code,0);resolve();});
    });
    await exited;
    assert.match(waiting.out(),/"nudged": true/);
    const messaging=release(startWait(['--for','message']));
    const exitedFor=new Promise<void>((resolve,reject) => {
      const timer=setTimeout(()=>reject(new Error('for-message wait did not end within 3 s of the nudge')),3000);
      messaging.child.once('exit',code=>{clearTimeout(timer);assert.equal(code,0);resolve();});
    });
    await exitedFor;
    assert.match(messaging.out(),/"nudged": true/);
    assert.equal(nudge(),0);
  } finally {
    await Promise.all(processes.filter(p=>p.exitCode===null&&p.signalCode===null).map(p=>new Promise<void>(resolve=>{p.once('exit',()=>resolve());p.kill('SIGTERM');})));
    rmSync(root,{recursive:true,force:true});
  }
});

// Docs: VORTEX_v5.1.md section 6.5
test('subscription commands validate arguments without a running service', {timeout:60000}, async () => {
  const root=mkdtempSync(join(tmpdir(),'vortex-cli-sub-validate-'));
  try {
    const run=(args:string[]) => {
      const r=spawnSync('bun',['src/cli.ts',...args,'--dir',join(root,'nobody')],{encoding:'utf8',timeout:30000});
      return {exit:r.status,json:JSON.parse(r.stdout.trim()||'null') as any,raw:r.stdout+r.stderr};
    };
    const id='a'.repeat(32);
    for (const args of [
      ['subscribe','--conference',id],
      ['subscribe','--conference',id,'--ttl','0'],
      ['subscribe','--conference',id,'--ttl','604801'],
      ['subscribe','--conference',id,'--ttl','soon'],
      ['subscribe','--ttl','60'],
      ['subscribe','--conference','bad','--ttl','60'],
      ['unsubscribe','--session','s'],
      ['unsubscribe','--conference','bad','--session','s'],
    ]) {
      const r=run(args);
      assert.notEqual(r.exit,0,args.join(' '));
      assert.equal(typeof (r.json as any)?.error,'string',args.join(' '));
    }
    const ok=run(['subscribe','--conference',id,'--ttl','60']);
    assert.notEqual(ok.exit,0);
    assert.match(ok.raw,/ENOENT|no such file/);
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});

// Docs: VORTEX_v5.1.md section 6.5
test('subscription CLI and API route to the service without loading the model', {timeout:90000}, async () => {
  const root=mkdtempSync(join(tmpdir(),'vortex-cli-sub-'));
  const processes:ChildProcess[]=[];
  const forbid={VORTEX_TEST_FORBID_MODEL_LOAD:'1'};
  const run=(args:string[],dir:string) => {
    const r=spawnSync('bun',['src/cli.ts',...args,'--dir',dir],{encoding:'utf8',timeout:30000});
    return {exit:r.status,json:JSON.parse(r.stdout.trim()||'null') as any,raw:r.stdout+r.stderr};
  };
  const start=async (name:string,extra:string[]) => {
    const dir=join(root,name);
    mkdirSync(dir,{recursive:true});
    if(existsSync(join(dir,'endpoint.json'))) unlinkSync(join(dir,'endpoint.json'));
    const child=spawn('bun',['src/cli.ts','serve','--dir',dir,'--name',name,'--port','0',...extra],
      {stdio:'ignore',env:{...process.env,...forbid}});
    processes.push(child);
    const end=Date.now()+8000;
    while(!existsSync(join(dir,'endpoint.json'))) {
      if(child.exitCode!==null || Date.now()>end) throw new Error('test service did not start');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    return {dir,child};
  };
  try {
    const sem=await start('sem',['--semantic']);
    const id='b'.repeat(32);
    const denied=run(['subscribe','--conference',id,'--ttl','60'],sem.dir);
    assert.notEqual(denied.exit,0);
    assert.match(denied.json.error,/not a member of this conference with this session/);
    const listed=run(['subscriptions'],sem.dir);
    assert.equal(listed.exit,0,listed.raw);
    assert.deepEqual(listed.json,{subscriptions:[]});
    const filtered=run(['subscriptions','--session','nobody'],sem.dir);
    assert.equal(filtered.exit,0,filtered.raw);
    assert.deepEqual(filtered.json,{subscriptions:[]});
    const gone=run(['unsubscribe','--conference',id],sem.dir);
    assert.equal(gone.exit,0,gone.raw);
    assert.deepEqual(gone.json,{unsubscribed:false});
    const endpoint=JSON.parse(readFileSync(join(sem.dir,'endpoint.json'),'utf8'));
    const over=await fetch(endpoint.url+'/subscribe',{method:'POST',headers:{authorization:'Bearer '+endpoint.token,
      'content-type':'application/json'},body:JSON.stringify({conference:id,ttl:9999999})});
    assert.equal(over.status,400);
    assert.match((await over.json() as any).error,/invalid subscription ttl/);
    const plain=await start('plain',[]);
    const plainDenied=run(['subscribe','--conference',id,'--ttl','60'],plain.dir);
    assert.notEqual(plainDenied.exit,0);
    assert.match(plainDenied.json.error,/not enabled/);
    const plainListed=run(['subscriptions'],plain.dir);
    assert.notEqual(plainListed.exit,0);
    assert.match(plainListed.json.error,/not enabled/);
    const badDir=join(root,'bad');
    mkdirSync(badDir,{recursive:true});
    const bad=spawn('bun',['src/cli.ts','serve','--dir',badDir,'--name','bad','--port','0',
      '--subscription-limit','0'],{stdio:'ignore',env:{...process.env,...forbid}});
    processes.push(bad);
    await new Promise(resolve=>setTimeout(resolve,3000));
    assert.ok(!existsSync(join(badDir,'endpoint.json')),'operator bound violation must fail before serving');
    assert.notEqual(bad.exitCode,null);
    const badTtl=join(root,'badttl');
    mkdirSync(badTtl,{recursive:true});
    const bad2=spawn('bun',['src/cli.ts','serve','--dir',badTtl,'--name','bad2','--port','0',
      '--subscription-max-ttl','99999999'],{stdio:'ignore',env:{...process.env,...forbid}});
    processes.push(bad2);
    await new Promise(resolve=>setTimeout(resolve,3000));
    assert.ok(!existsSync(join(badTtl,'endpoint.json')),'operator ttl violation must fail before serving');
    assert.notEqual(bad2.exitCode,null);
  } finally {
    await Promise.all(processes.filter(p=>p.exitCode===null&&p.signalCode===null).map(p=>new Promise<void>(resolve=>{p.once('exit',()=>resolve());p.kill('SIGTERM');})));
    rmSync(root,{recursive:true,force:true});
  }
});

// Docs: VORTEX_v5.1.md sections 6.1 and 11.5
test('revise validates arguments without a running service', {timeout:60000}, async () => {
  const root=mkdtempSync(join(tmpdir(),'vortex-cli-revise-validate-'));
  try {
    const run=(args:string[]) => {
      const r=spawnSync('bun',['src/cli.ts',...args,'--dir',join(root,'nobody')],{encoding:'utf8',timeout:30000});
      return {exit:r.status,json:JSON.parse(r.stdout.trim()||'null') as any,raw:r.stdout+r.stderr};
    };
    const id='a'.repeat(32);
    for (const args of [
      ['revise','--conference',id],
      ['revise','--conference',id,'--statement',''],
      ['revise','--statement','new topic'],
      ['revise','--conference','bad','--statement','new topic'],
    ]) {
      const r=run(args);
      assert.notEqual(r.exit,0,args.join(' '));
      assert.equal(typeof (r.json as any)?.error,'string',args.join(' '));
    }
    const ok=run(['revise','--conference',id,'--statement','new topic']);
    assert.notEqual(ok.exit,0);
    assert.match(ok.raw,/ENOENT|no such file/);
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});
