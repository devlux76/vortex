// Charged room (2026-10-23): the router selects and charges one room per ring,
// but the service dropped it and adapters processed the global oldest unread
// event, so one room's budget paid for another room's mail. The service now
// hands the charged room to the adapter as VORTEX_ROOM.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProcess } from './presence.ts';

async function ringRoom(foreground=false) {
  const root=mkdtempSync(join(tmpdir(),'vortex-ring-room-'));
  const dir=join(root,'owner'),sock=join(root,'router.sock'),seen=join(root,'seen');
  mkdirSync(dir,{recursive:true,mode:0o700});
  if(foreground)writeFileSync(join(dir,'presence.json'),JSON.stringify([{pid:process.pid,startTime:readProcess(process.pid)!.startTime}]));
  const conference=(id:string,cursor:number)=>({cursor,kind:'conference_message',room:'conference:'+id,peer:'p',conference:id,session:'s',body:'b',trust:'untrusted_peer_content'});
  const older='a'.repeat(32),charged='b'.repeat(32);
  writeFileSync(join(dir,'state.json'),JSON.stringify({rooms:{},seen:[],cursor:2,acked:0,events:[conference(older,1),conference(charged,2)]}),{mode:0o600});
  const adapter=join(root,'adapter.sh');
  writeFileSync(adapter,`#!/bin/sh\nprintf '%s\\n%s\\n' "$VORTEX_ROOM" "$VORTEX_UNREAD" > '${seen}'\n`,{mode:0o700});
  const sockets:Socket[]=[];let state:any;
  const server=createServer(socket=>{
    sockets.push(socket);let buffer='';
    socket.on('data',chunk=>{
      buffer+=chunk.toString();let at:number;
      while((at=buffer.indexOf('\n'))>=0){
        const message=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);
        if(message.t==='hello') socket.write('{"t":"welcome"}\n');
        else if(message.t==='state') state=message;
      }
    });
  });
  await new Promise<void>(r=>server.listen(sock,r));
  let service:ChildProcess|undefined;
  try {
    service=spawn('bun',['src/cli.ts','serve','--dir',dir,'--name',foreground?'codex':'owner','--port','0','--backbone',sock,'--on-ring',adapter],{stdio:'ignore',env:{...process.env,...(foreground?{VORTEX_CODEX_FOREGROUND_THREAD:'01a16c2f-564b-7721-850b-a8039f1fe79d'}:{})}});
    const until=async(what:string,check:()=>boolean)=>{const end=Date.now()+8000;while(!check()){assert.ok(Date.now()<end,what);await new Promise(r=>setTimeout(r,20));}};
    await until('router state',()=>state?.rooms?.length===2);
    if(foreground)assert.equal(state.waiters,0,'a desktop host is not a listener that resumes a model turn');
    const hash=createHash('sha256').update('conference:'+charged).digest('hex');
    assert.ok(state.rooms.some((r:any)=>r.room===hash),'the charged room is reported by hash only');
    sockets[0].write(JSON.stringify({t:'ring',ring:'ring-1',room:hash,unread:1})+'\n');
    await until('adapter ran',()=>existsSync(seen)&&readFileSync(seen,'utf8').split('\n').length>2);
    assert.deepEqual(readFileSync(seen,'utf8').trim().split('\n'),['conference:'+charged,'2']);
  } finally {
    if(service&&service.exitCode===null) await new Promise<void>(r=>{service!.once('exit',()=>r());service!.kill('SIGTERM');});
    for(const s of sockets) s.destroy();
    await new Promise<void>(r=>server.close(()=>r()));
    rmSync(root,{recursive:true,force:true});
  }
}

test('a ring hands the adapter the room the router charged, not the oldest unread room', {timeout:30000},()=>ringRoom());
test('foreground desktop delivery rings despite an old live-host presence registration', {timeout:30000},()=>ringRoom(true));
