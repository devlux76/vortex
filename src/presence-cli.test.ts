import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pause=()=>new Promise(r=>setTimeout(r,20));
test('attach HTTP/CLI: fanout, competing ack, next, persistent hosts, restart and withdrawal', {timeout:30000}, async()=>{
  const root=mkdtempSync(join(tmpdir(),'vortex-presence-cli-'));
  const processes:ChildProcess[]=[];
  const streams:ReadableStreamDefaultReader<Uint8Array>[]=[];
  const start=async(name:string)=>{
    const dir=join(root,name),file=join(dir,'endpoint.json');
    if(existsSync(file)) unlinkSync(file);
    const child=spawn('bun',['src/cli.ts','serve','--dir',dir,'--name',name,'--port','0'],{stdio:'ignore'});
    processes.push(child);
    const end=Date.now()+8000;
    while(!existsSync(file)){assert.equal(child.exitCode,null);assert.ok(Date.now()<end,'service start');await pause();}
    const ep=JSON.parse(readFileSync(file,'utf8'));
    const post=(op:string,args:unknown={})=>fetch(ep.url+'/'+op,{method:'POST',headers:{authorization:'Bearer '+ep.token,'content-type':'application/json'},body:JSON.stringify(args)});
    const call=async(op:string,args:unknown={})=>{const r=await post(op,args);const value:any=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value;};
    const attach=async(args:unknown={})=>{
      const response=await post('attach',args);assert.equal(response.status,200);assert.match(response.headers.get('content-type')!,/ndjson/);
      const reader=response.body!.getReader();streams.push(reader);let pending='';
      return {reader,next:async()=>{for(;;){const at=pending.indexOf('\n');if(at>=0){const row=pending.slice(0,at);pending=pending.slice(at+1);return JSON.parse(row);}const chunk=await reader.read();if(chunk.done)return undefined;pending+=new TextDecoder().decode(chunk.value);}}};
    };
    return {dir,child,post,call,attach,ep};
  };
  try {
    let a=await start('a');const b=await start('b');
    assert.equal((await fetch(a.ep.url+'/attach',{method:'POST',body:'{}'})).status,403);
    assert.equal((await a.post('attach',{next:'yes'})).status,400);
    assert.equal((await a.post('attach',{hostPid:-1})).status,400);
    const ai=await a.call('info'),bi=await b.call('info');await a.call('dial',{peer:bi.addrs[0]});
    const {room}=await a.call('invite',{peer:bi.peerId});await b.call('wait',{timeout:2});await b.call('accept',{room});
    await a.call('wait',{timeout:2});await a.call('ack',{cursor:'read'});
    const first=await a.attach({hostPid:process.pid}),second=await a.attach();
    const initial=await first.next();assert.equal(initial.attached,true);assert.equal(initial.unread,0);await second.next();
    assert.equal((await a.call('info')).presence.lines,2);
    // Exercise the actual CLI past the server's 10-second request backstop.
    const idle=spawn('bun',['src/cli.ts','attach','--dir',a.dir],{stdio:['ignore','pipe','pipe']});processes.push(idle);
    let idleOutput='';idle.stdout!.on('data',chunk=>idleOutput+=chunk);
    const attachedBy=Date.now()+2000;while(!idleOutput.includes('\n')){assert.ok(Date.now()<attachedBy);await pause();}
    await new Promise(r=>setTimeout(r,10500));assert.equal(idle.exitCode,null,'idle attachment must not expire');
    await b.call('send',{room,text:'private peer text'});
    const one=await first.next(),two=await second.next();assert.deepEqual(one,two);assert.deepEqual(Object.keys(one).sort(),['cursor','unread']);assert.equal(one.unread,1);
    const epoch=readFileSync(join(a.dir,'presence-epoch'),'utf8');
    const noticedBy=Date.now()+2000;while(idleOutput.trim().split('\n').length<2){assert.ok(Date.now()<noticedBy);await pause();}
    assert.deepEqual(JSON.parse(idleOutput.trim().split('\n')[1]),one);
    idle.kill('SIGTERM');await new Promise(r=>idle.once('exit',r));
    await a.call('ack',{cursor:one.cursor});assert.notEqual(readFileSync(join(a.dir,'presence-epoch'),'utf8'),epoch);assert.deepEqual((await a.call('read')).events,[]);
    await first.reader.cancel();await second.reader.cancel();
    const end=Date.now()+2000;while((await a.call('info')).presence.lines){assert.ok(Date.now()<end);await pause();}
    assert.deepEqual((await a.call('info')).presence,{lines:0,hosts:[{pid:process.pid,alive:true}],present:true});
    const next=await a.attach({next:true});assert.equal((await next.next()).unread,0);
    await b.call('send',{room,text:'next arrival'});assert.equal((await next.next()).unread,1);assert.equal(await next.next(),undefined);
    const cli=spawn('bun',['src/cli.ts','attach','--dir',a.dir,'--next'],{stdio:['ignore','pipe','pipe']});processes.push(cli);
    let output='';cli.stdout!.on('data',b=>output+=b);assert.equal(await new Promise(r=>cli.once('exit',r)),0);assert.equal(JSON.parse(output).unread,1);
    a.child.kill('SIGTERM');await new Promise(r=>a.child.once('exit',r));a=await start('a');
    assert.deepEqual((await a.call('info')).presence.hosts,[{pid:process.pid,alive:true}]);
    const withdraw=await a.attach({hostPid:0,next:true});await withdraw.next();assert.equal(await withdraw.next(),undefined);
    assert.deepEqual((await a.call('info')).presence,{lines:0,hosts:[],present:false});
    await a.call('read');await a.call('ack',{cursor:'read'});
    const waiting=a.call('wait',{timeout:2});while(!(await a.call('info')).presence.lines)await pause();
    assert.equal((await a.call('info')).presence.present,true);await a.call('nudge');await waiting;
  } finally {
    for(const reader of streams)await reader.cancel().catch(()=>{});
    await Promise.all(processes.filter(p=>p.exitCode===null&&p.signalCode===null).map(p=>new Promise<void>(r=>{p.once('exit',()=>r());p.kill('SIGTERM');})));
    rmSync(root,{recursive:true,force:true});
  }
});

test('attach rejects malformed host-pid before opening owner state',()=>{
  const dir=join(tmpdir(),'vortex-no-such-owner-'+process.pid);
  const result=spawnSync(process.execPath,['src/cli.ts','attach','--dir',dir,'--host-pid','1.5'],{encoding:'utf8'});
  assert.equal(result.status,1);
  const error=JSON.parse(result.stdout);assert.match(error.error,/--host-pid/);assert.equal(error.got,'1.5');
  assert.equal(existsSync(dir),false);
});

// skills/vortex/SKILL.md: a session-scoped live line leaves other topics to the ring adapter.
test('a session-scoped attach line does not claim a new direct topic', {timeout:30000}, async()=>{
  const root=mkdtempSync(join(tmpdir(),'vortex-presence-scope-'));
  const processes:ChildProcess[]=[];
  try {
    const start=async(name:string)=>{
      const dir=join(root,name),file=join(dir,'endpoint.json');
      const child=spawn('bun',['src/cli.ts','serve','--dir',dir,'--name',name,'--port','0'],{stdio:'ignore'});processes.push(child);
      const end=Date.now()+8000;
      while(!existsSync(file)){assert.equal(child.exitCode,null);assert.ok(Date.now()<end,'service start');await pause();}
      const ep=JSON.parse(readFileSync(file,'utf8'));
      const post=(op:string,args:unknown={})=>fetch(ep.url+'/'+op,{method:'POST',headers:{authorization:'Bearer '+ep.token,'content-type':'application/json'},body:JSON.stringify(args)});
      const call=async(op:string,args:unknown={})=>{const r=await post(op,args);const value:any=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value;};
      return {dir,post,call};
    };
    const a=await start('a'),b=await start('b');
    for(const session of ['',7,'x'.repeat(129)]) assert.equal((await a.post('attach',{session})).status,400);
    const bi=await b.call('info');await a.call('dial',{peer:bi.addrs[0]});
    const {room}=await a.call('invite',{peer:bi.peerId});await b.call('wait',{timeout:2});await b.call('accept',{room});
    await a.call('wait',{timeout:2});await a.call('ack',{cursor:'read'});
    const cli=spawn('bun',['src/cli.ts','attach','--dir',a.dir,'--next','--session','live'],{stdio:['ignore','pipe','pipe']});processes.push(cli);
    let output='';cli.stdout!.on('data',chunk=>output+=chunk);
    const attachedBy=Date.now()+4000;while(!output.includes('\n')){assert.ok(Date.now()<attachedBy);await pause();}
    assert.equal(JSON.parse(output).unread,0);
    assert.equal((await a.call('info')).presence.present,false,'a scoped line alone claims no topic');
    await b.call('send',{room,text:'a new topic'});
    const arrivedBy=Date.now()+4000;while(!(await a.call('read')).events.length){assert.ok(Date.now()<arrivedBy);await pause();}
    await new Promise(r=>setTimeout(r,300));
    assert.equal(cli.exitCode,null,'the scoped line stays attached: the new topic is not its own');
    assert.equal(output.trim().split('\n').length,1);
    assert.equal((await a.call('info')).presence.present,false);
  } finally {
    await Promise.all(processes.filter(p=>p.exitCode===null&&p.signalCode===null).map(p=>new Promise<void>(r=>{p.once('exit',()=>r());p.kill('SIGTERM');})));
    rmSync(root,{recursive:true,force:true});
  }
});

// Head-of-line (2026-10-23): a stale foreign direct message at the head of
// the queue kept a `--session live` line from waking for its own conference
// mail behind it, and an ack through that mail would have discarded it.
test('a scoped line wakes for its own mail behind a foreign head, and a scoped ack loses no foreign event', {timeout:30000}, async()=>{
  const root=mkdtempSync(join(tmpdir(),'vortex-presence-hol-'));
  const processes:ChildProcess[]=[];
  try {
    const dir=join(root,'a'),file=join(dir,'endpoint.json');
    mkdirSync(dir,{recursive:true,mode:0o700});
    const foreign=(cursor:number)=>({cursor,kind:'message',room:'["a","stale"]',peer:'stale',body:'stale ring reply',trust:'untrusted_peer_content'});
    const own=(cursor:number)=>({cursor,kind:'conference_message',room:'conference:'+'c'.repeat(32),peer:'p',conference:'c'.repeat(32),session:'live',body:'owned',trust:'untrusted_peer_content'});
    writeFileSync(join(dir,'state.json'),JSON.stringify({rooms:{},seen:[],cursor:3,acked:0,events:[foreign(1),own(2),foreign(3)]}),{mode:0o600});
    const child=spawn('bun',['src/cli.ts','serve','--dir',dir,'--name','a','--port','0'],{stdio:'ignore'});processes.push(child);
    const end=Date.now()+8000;
    while(!existsSync(file)){assert.equal(child.exitCode,null);assert.ok(Date.now()<end,'service start');await pause();}
    const ep=JSON.parse(readFileSync(file,'utf8'));
    const call=async(op:string,args:unknown={})=>{const r=await fetch(ep.url+'/'+op,{method:'POST',headers:{authorization:'Bearer '+ep.token,'content-type':'application/json'},body:JSON.stringify(args)});const value:any=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value;};
    const next=spawnSync('bun',['src/cli.ts','attach','--dir',dir,'--next','--session','live'],{encoding:'utf8',timeout:8000});
    assert.equal(next.status,0,'the --next line returns instead of waiting behind the foreign head');
    assert.deepEqual(JSON.parse(next.stdout.trim()),{attached:true,cursor:3,unread:1});
    const stream=spawn('bun',['src/cli.ts','attach','--dir',dir,'--session','live'],{stdio:['ignore','pipe','pipe']});processes.push(stream);
    let output='';stream.stdout!.on('data',chunk=>output+=chunk);
    const attachedBy=Date.now()+4000;while(!output.includes('\n')){assert.ok(Date.now()<attachedBy);await pause();}
    assert.equal((await call('info')).presence.present,false,'the foreign head still rings the adapter');
    assert.deepEqual((await call('read',{session:'live'})).events.map((e:any)=>e.cursor),[2]);
    assert.deepEqual(await call('ack',{cursor:3,session:'live'}),{acked:3,session:'live'});
    assert.deepEqual((await call('read')).events.map((e:any)=>e.cursor),[1,3],'both foreign events are still unread');
    assert.deepEqual((await call('read',{session:'live'})).events,[]);
    await new Promise(r=>setTimeout(r,200));
    assert.equal(output.trim().split('\n').length,1,'the streaming line was not told twice about mail it already had');
    await call('ack',{cursor:1});
    assert.deepEqual((await call('read')).events.map((e:any)=>e.cursor),[3]);
    const saved=JSON.parse(readFileSync(join(dir,'state.json'),'utf8'));
    assert.equal(saved.acked,2,'the watermark crossed the handled owned event');
    assert.equal(saved.handled,undefined);
  } finally {
    await Promise.all(processes.filter(p=>p.exitCode===null&&p.signalCode===null).map(p=>new Promise<void>(r=>{p.once('exit',()=>r());p.kill('SIGTERM');})));
    rmSync(root,{recursive:true,force:true});
  }
});
