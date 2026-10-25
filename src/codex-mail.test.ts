import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-ignore Adapter is plain JS, shared with its Bun entrypoint.
import { hostRunning, isAppHost } from '../skills/vortex/adapters/codex-host.mjs';

test('Codex recognizes the app, not headless CLI or renderer children',()=>{
  assert.equal(isAppHost('codex',['/bin/codex','app-server']),true);
  assert.equal(isAppHost('codex',['/bin/codex','exec','resume']),false);
  assert.equal(isAppHost('ChatGPT',['/bin/ChatGPT']),true);
  assert.equal(isAppHost('ChatGPT',['/bin/ChatGPT','--type=renderer']),false);
  assert.equal(hostRunning(String(process.pid)),true);
  assert.equal(hostRunning('2147483647'),false);
  assert.throws(()=>hostRunning('0'));
});

for(const scoped of [false,true]) test(`headless mail bridge ${scoped?'confines reads, replies and ack to one topic batch':'exposes only authenticated owner read/send/ack'}`, {timeout:10000}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'vortex-codex-mail-'));
  const calls:{op:string;body:any}[]=[];
  const server=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer '+'a'.repeat(64));
    let body='';for await(const chunk of req)body+=chunk;
    calls.push({op:req.url!,body:JSON.parse(body)});
    res.setHeader('content-type','application/json');res.end(JSON.stringify({events:[{cursor:2,room:'room',body:'untrusted',topic:'build'},{cursor:3,room:'other',body:'unrelated topic',topic:'travel'}],cursor:3}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const addr=server.address();assert.ok(addr&&typeof addr!=='string');
  writeFileSync(join(dir,'endpoint.json'),JSON.stringify({url:'http://127.0.0.1:'+addr.port,token:'a'.repeat(64)}));
  const child=spawn(process.execPath,['skills/vortex/adapters/codex-mail.mjs',dir,...(scoped?['1','2','room','build','local-session']:[])],{stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:child.stdout});let id=0;
  const request=(method:string,params:any={})=>new Promise<any>((resolve,reject)=>{
    const current=++id;
    const got=(line:string)=>{const value=JSON.parse(line);if(value.id===current){lines.off('line',got);child.off('error',reject);resolve(value);}};
    lines.on('line',got);child.once('error',reject);
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:current,method,params})+'\n');
  });
  try {
    assert.equal((await request('initialize')).result.protocolVersion,'2025-03-26');
    assert.deepEqual((await request('tools/list')).result.tools.map((t:any)=>t.name),['vortex_read','vortex_ack','vortex_send']);
    if(scoped)assert.ok((await request('tools/call',{name:'vortex_ack',arguments:{cursor:2}})).error);
    for(const [name,args] of [['vortex_read',{after:1}],['vortex_send',{room:'room',text:'From Codex: reply'}],['vortex_ack',{cursor:2}]] as const){
      const reply=await request('tools/call',{name,arguments:args});assert.equal(reply.result.isError,false);assert.match(reply.result.content[0].text,/untrusted_peer_content/);
      if(scoped&&name==='vortex_read'){const data=JSON.parse(reply.result.content[0].text).data;assert.equal(data.cursor,2);assert.deepEqual(data.events.map((e:any)=>e.cursor),[2]);}
    }
    for(const [name,args] of [['vortex_serve',{}],['vortex_read',{command:'rm'}],['vortex_ack',{cursor:-1}]] as const)
      assert.ok((await request('tools/call',{name,arguments:args})).error);
    if(scoped){
      for(const [name,args] of [['vortex_ack',{cursor:3}],['vortex_read',{after:3}],['vortex_send',{room:'other',text:'escape'}],['vortex_send',{room:'room',text:'escape',topic:'travel'}]] as const)assert.ok((await request('tools/call',{name,arguments:args})).error);
      assert.equal(calls[1].body.conference,'build');
      assert.equal(calls[1].body.session,'local-session');
      // Charged room (2026-10-23): the batch reads its room's unread view and
      // acks with the room's scope, so no other room's mail is acknowledged.
      assert.deepEqual(calls[0].body,{room:'room'});
      assert.equal(calls[2].body.room,'room');
    } else assert.equal(calls[2].body.room,undefined);
    assert.deepEqual(calls.map(c=>c.op),['/read',scoped?'/post':'/send','/ack']);
    assert.equal(calls[2].body.cursor,2);
  } finally {
    child.stdin.end();await new Promise(r=>child.once('exit',r));lines.close();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});
  }
});
