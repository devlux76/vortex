import assert from 'node:assert/strict';
import { Presence } from './presence.ts';
import { test } from 'node:test';
import { createServer, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conversations } from './core/conversations.ts';
import { connectBackbone } from './backbone.ts';

async function fixture(helloResponses: string[] = []) {
  const dir=mkdtempSync(join(tmpdir(),'vortex-backbone-'));
  const path=join(dir,'router.sock');
  const messages: Record<string,any>[]=[];
  const sockets: Socket[]=[];
  const server=createServer(socket=>{
    sockets.push(socket);
    let buffer='';
    socket.on('data',chunk=>{
      buffer+=chunk.toString();
      let at:number;
      while((at=buffer.indexOf('\n'))>=0) {
        const message=JSON.parse(buffer.slice(0,at)); buffer=buffer.slice(at+1);
        messages.push(message);
        if(message.t==='hello') {
          const reason=helloResponses.shift();
          if(reason) socket.end(JSON.stringify({t:'error',reason})+'\n');
          else socket.write('{"t":"welcome"}\n');
        }
      }
    });
  });
  await new Promise<void>(resolve=>server.listen(path,resolve));
  const core=new Conversations('a',{send:async()=>{},save:()=>{}});
  const room=await core.invite('b');
  await core.receive('b',{kind:'accept',room});
  await core.ack(core.read().cursor);
  const waitFor=async(check:()=>boolean)=>{
    const end=Date.now()+2000;
    while(!check()) {
      if(Date.now()>end) throw Error('backbone fixture deadline');
      await new Promise(resolve=>setTimeout(resolve,10));
    }
  };
  return {path,core,room,messages,sockets,waitFor,close:async()=>{
    for(const socket of sockets) socket.destroy();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    rmSync(dir,{recursive:true,force:true});
  }};
}

test('backbone client pushes complete metadata, hashes rooms, and reports adapter lifecycle', async()=>{
  const f=await fixture();
  const rings: any[]=[];
  const bridge=connectBackbone({path:f.path,owner:'codex',token:'owner-token-123456',quietMs:0,core:f.core,onRing:ring=>rings.push(ring),onError:()=>{}});
  try {
    await f.waitFor(()=>f.messages.some(m=>m.t==='state'));
    assert.deepEqual(f.messages[0],{t:'hello',v:1,owner:'codex',token:'owner-token-123456',quiet_ms:0});
    for(let i=0;i<150;i++) f.core.receive('stranger'+i,{kind:'invite',room:f.core.roomFor('stranger'+i)});
    f.core.receive('b',{kind:'message',room:f.room,id:'m',body:'PEER_BODY_MUST_STAY_LOCAL'});
    await f.waitFor(()=>f.messages.some(m=>m.t==='state'&&m.rooms.length===1));
    const state=f.messages.filter(m=>m.t==='state').at(-1)!;
    assert.equal(state.rooms[0].unread,1);
    assert.match(state.rooms[0].room,/^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(f.messages).includes('PEER_BODY_MUST_STAY_LOCAL'));
    assert.ok(!JSON.stringify(f.messages).includes(f.room));
    f.sockets[0].write(JSON.stringify({t:'ring',ring:'boot-1',room:state.rooms[0].room,unread:1})+'\n');
    await f.waitFor(()=>rings.length===1);
    // The adapter must work on the room the router charged, so the local
    // ring carries that room's name (never sent to the router) and count.
    assert.deepEqual(rings[0],{ring:'boot-1',room:state.rooms[0].room,name:f.room,roomUnread:1,unread:1});
    bridge.started('boot-1');
    bridge.acted();
    bridge.exited('boot-1',76);
    await f.waitFor(()=>f.messages.some(m=>m.t==='exited'));
    assert.ok(f.messages.some(m=>m.t==='started'&&m.ring==='boot-1'));
    assert.ok(f.messages.some(m=>m.t==='acted'));
    assert.deepEqual(f.messages.find(m=>m.t==='exited'),{t:'exited',ring:'boot-1',code:76});
  } finally {bridge.stop(); await f.close();}
});

test('control-only rooms stay readable without being reported to the wake router', async()=>{
  const f=await fixture();
  const bridge=connectBackbone({path:f.path,owner:'codex',token:'owner-token-123456',quietMs:0,core:f.core,onRing:()=>assert.fail('control event rang'),onError:()=>{}});
  try {
    await f.waitFor(()=>f.messages.some(m=>m.t==='state'));
    const first=f.messages.length;
    await f.core.recordMatch({interest:'a'.repeat(32),record:'b'.repeat(32),peer:'b',tier:'exact',score:1,fullScore:1,addrs:['/ip4/127.0.0.1/tcp/1/p2p/b']});
    await f.waitFor(()=>f.messages.slice(first).some(m=>m.t==='state'));
    assert.deepEqual(f.messages.filter(m=>m.t==='state').at(-1)!.rooms,[]);
    assert.equal(f.core.read().events[0]?.kind,'match');
  } finally {bridge.stop();await f.close();}
});

test('backbone client resynchronizes a running adapter after disconnect without duplicate dispatch', async()=>{
  const f=await fixture();
  const rings:any[]=[];
  const bridge=connectBackbone({path:f.path,owner:'codex',token:'owner-token-123456',quietMs:0,core:f.core,onRing:ring=>rings.push(ring),onError:()=>{}});
  try {
    f.core.receive('b',{kind:'message',room:f.room,id:'m',body:'x'});
    await f.waitFor(()=>f.messages.some(m=>m.t==='state'&&m.rooms.length===1));
    const room=f.messages.filter(m=>m.t==='state').at(-1)!.rooms[0].room;
    f.sockets[0].write(JSON.stringify({t:'ring',ring:'boot-1',room,unread:1})+'\n');
    await f.waitFor(()=>rings.length===1);
    bridge.started('boot-1');
    f.sockets[0].destroy();
    await f.waitFor(()=>f.sockets.length===2);
    await f.waitFor(()=>f.messages.some(m=>m.t==='state'&&m.running==='boot-1'));
    f.sockets[1].write(JSON.stringify({t:'ring',ring:'new-2',room,unread:1})+'\n');
    await f.waitFor(()=>f.messages.some(m=>m.t==='refused'&&m.ring==='new-2'));
    assert.equal(rings.length,1);
    bridge.exited('boot-1',0);
  } finally {bridge.stop(); await f.close();}
});

test('backbone client refuses stale wake commands after an owner acknowledges the mail', async()=>{
  const f=await fixture();
  const rings:any[]=[];
  const bridge=connectBackbone({path:f.path,owner:'codex',token:'owner-token-123456',quietMs:0,core:f.core,onRing:ring=>rings.push(ring),onError:()=>{}});
  try {
    f.core.receive('b',{kind:'message',room:f.room,id:'m',body:'x'});
    await f.waitFor(()=>f.messages.some(m=>m.t==='state'&&m.rooms.length===1));
    const room=f.messages.filter(m=>m.t==='state').at(-1)!.rooms[0].room;
    await f.core.ack(f.core.read().cursor);
    f.sockets[0].write(JSON.stringify({t:'ring',ring:'boot-1',room,unread:1})+'\n');
    await f.waitFor(()=>f.messages.some(m=>m.t==='refused'));
    assert.equal(rings.length,0);
  } finally {bridge.stop(); await f.close();}
});

test('a delivered wait reports owner activity before releasing wake suppression', async()=>{
  const f=await fixture();
  const bridge=connectBackbone({path:f.path,owner:'codex',token:'owner-token-123456',quietMs:0,core:f.core,onRing:()=>{},onError:()=>{}});
  try {
    await f.waitFor(()=>f.messages.some(m=>m.t==='state'));
    const waiting=f.core.wait(undefined,1000).then(page=>{bridge.acted();return page;});
    await f.waitFor(()=>f.messages.some(m=>m.t==='state'&&m.waiters===1));
    const first=f.messages.length;
    f.core.receive('b',{kind:'message',room:f.room,id:'m',body:'wake'});
    await waiting;
    await f.waitFor(()=>f.messages.slice(first).some(m=>m.t==='state'&&m.waiters===0));
    assert.equal(f.messages[first].t,'acted');
  } finally {bridge.stop(); await f.close();}
});

test('owner-attached registration races retry without disabling future wakes', async()=>{
  const f=await fixture(['owner_attached']);
  const bridge=connectBackbone({path:f.path,owner:'codex',token:'owner-token-123456',quietMs:0,core:f.core,onRing:()=>{},onError:()=>{}});
  try {
    await f.waitFor(()=>f.messages.some(m=>m.t==='state'));
    assert.equal(f.messages.filter(m=>m.t==='hello').length,2);
  } finally {bridge.stop();await f.close();}
});

// Docs: VORTEX_v5.1.md §9.3 (event delivery/wake); Docs: ISSUES.md I8 (OTP wake backbone).
test('bridge status reflects welcome, disconnect, reconnect and stop', async()=>{
  const f=await fixture();
  const bridge=connectBackbone({path:f.path,owner:'codex',token:'owner-token-123456',quietMs:0,core:f.core,onRing:()=>{},onError:()=>{}});
  try {
    assert.deepEqual(bridge.status(),{connected:false});
    await f.waitFor(()=>f.messages.some(m=>m.t==='state'));
    assert.deepEqual(bridge.status(),{connected:true});
    const leaked=bridge.status() as {connected:boolean};
    leaked.connected=false;
    assert.deepEqual(bridge.status(),{connected:true});
    f.sockets[0].destroy();
    await f.waitFor(()=>bridge.status().connected===false);
    await f.waitFor(()=>f.messages.filter(m=>m.t==='hello').length===2);
    await f.waitFor(()=>bridge.status().connected===true);
    bridge.stop();
    assert.deepEqual(bridge.status(),{connected:false});
  } finally {bridge.stop(); await f.close();}
});

test('an adapter exit while disconnected is replayed before the reconnect snapshot', async()=>{
  const f=await fixture();
  const rings:any[]=[];
  const bridge=connectBackbone({path:f.path,owner:'codex',token:'owner-token-123456',quietMs:0,core:f.core,onRing:ring=>rings.push(ring),onError:()=>{}});
  try {
    f.core.receive('b',{kind:'message',room:f.room,id:'m',body:'x'});
    await f.waitFor(()=>f.messages.some(m=>m.t==='state'&&m.rooms.length===1));
    const room=f.messages.filter(m=>m.t==='state').at(-1)!.rooms[0].room;
    f.sockets[0].write(JSON.stringify({t:'ring',ring:'boot-1',room,unread:1})+'\n');
    await f.waitFor(()=>rings.length===1);
    bridge.started('boot-1');
    await f.waitFor(()=>f.messages.some(m=>m.t==='started'));
    f.sockets[0].destroy();
    await new Promise(resolve=>setTimeout(resolve,30));
    bridge.exited('boot-1',75);
    await f.waitFor(()=>f.messages.filter(m=>m.t==='hello').length===2);
    const hello=f.messages.findIndex((m,i)=>i>0&&m.t==='hello');
    await f.waitFor(()=>f.messages.slice(hello).some(m=>m.t==='state'));
    assert.deepEqual(f.messages[hello+1],{t:'exited',ring:'boot-1',code:75});
    assert.equal(f.messages[hello+2].running,null);
  } finally {bridge.stop();await f.close();}
});

test('presence suppresses router state and refuses a stale ring until detached', async()=>{
  const f=await fixture();let present=true;const rings:any[]=[];
  const bridge=connectBackbone({path:f.path,owner:'codex',token:'owner-token-123456',quietMs:0,core:f.core,present:()=>present,onRing:ring=>rings.push(ring),onError:()=>{}});
  try {
    await f.core.receive('b',{kind:'message',room:f.room,id:'presence',body:'private'});
    await f.waitFor(()=>f.messages.some(m=>m.t==='state'&&m.waiters>0&&m.rooms.length===1));
    const room=f.messages.filter(m=>m.t==='state').at(-1)!.rooms[0].room;
    f.sockets[0].write(JSON.stringify({t:'ring',ring:'stale',room,unread:1})+'\n');
    await f.waitFor(()=>f.messages.some(m=>m.t==='refused'&&m.ring==='stale'));
    assert.equal(rings.length,0);
    present=false;bridge.changed();
    await f.waitFor(()=>f.messages.some(m=>m.t==='state'&&m.waiters===0&&m.rooms.length===1));
    f.sockets[0].write(JSON.stringify({t:'ring',ring:'absent',room,unread:1})+'\n');
    await f.waitFor(()=>rings.length===1);
  } finally {bridge.stop();await f.close();}
});

// The same routing callback is used for open lines and persisted live hosts.
test('routing checks a held host identity again on arrival and prunes PID reuse',async()=>{
  const f=await fixture();let start='100';let bridge:ReturnType<typeof connectBackbone>|undefined;
  const dir=mkdtempSync(join(tmpdir(),'vortex-host-route-'));
  const presence=new Presence(dir,()=>bridge?.changed(),pid=>({pid,ppid:1,name:'claude',startTime:start}));
  presence.attach(()=>{},123)();
  const rings:any[]=[];
  bridge=connectBackbone({path:f.path,owner:'codex',token:'owner-token-123456',quietMs:0,core:f.core,present:()=>presence.info(0).present,onRing:r=>rings.push(r),onError:()=>{}});
  try{
    await f.core.receive('b',{kind:'message',room:f.room,id:'host-live',body:'held'});
    await f.waitFor(()=>f.messages.some(m=>m.t==='state'&&m.waiters===1&&m.rooms.length===1));
    const room=f.messages.filter(m=>m.t==='state').at(-1)!.rooms[0].room;
    f.sockets[0].write(JSON.stringify({t:'ring',ring:'host-live',room,unread:1})+'\n');
    await f.waitFor(()=>f.messages.some(m=>m.t==='refused'&&m.ring==='host-live'));
    assert.equal(rings.length,0);
    start='101';
    await f.core.receive('b',{kind:'message',room:f.room,id:'host-reused',body:'ring now'});
    await f.waitFor(()=>f.messages.some(m=>m.t==='state'&&m.waiters===0&&m.rooms[0]?.unread===2));
    f.sockets[0].write(JSON.stringify({t:'ring',ring:'host-reused',room,unread:2})+'\n');
    await f.waitFor(()=>rings.length===1);
    assert.deepEqual(presence.info(0).hosts,[]);
  }finally{bridge.stop();await f.close();rmSync(dir,{recursive:true,force:true});}
});



// Docs: VORTEX_v5.1.md section 9.3; ISSUES.md I10 (quiet owner).
test('backbone rings option controls whether rooms are reported', async () => {
  const make = async (rings?: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), 'vortex-backbone-'));
    const path = join(dir, 'router.sock');
    const messages: any[] = [];
    const sockets: any[] = [];
    const server = createServer((socket: any) => {
      sockets.push(socket);
      let buffer = '';
      socket.on('data', (chunk: any) => {
        buffer += chunk.toString();
        let at: number;
        while ((at = buffer.indexOf('\n')) >= 0) {
          const m = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
          messages.push(m);
          if (m.t === 'hello') socket.write('{"t":"welcome"}\n');
        }
      });
    });
    await new Promise<void>(resolve => server.listen(path, resolve));
    const core = new Conversations('a', { send: async () => {}, save: () => {} });
    const room = await core.invite('b');
    await core.receive('b', { kind: 'accept', room });
    await core.receive('b', { kind: 'message', room, id: 'data', body: 'wake data' });
    const bridge = connectBackbone({ path, owner: 'codex', token: 'owner-token-123456', quietMs: 0, core, rings, onRing: () => {}, onError: () => {} });
    const waitFor = async (check: () => boolean) => {
      const end = Date.now() + 2000;
      while (!check()) {
        if (Date.now() > end) throw Error('backbone fixture deadline');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    await waitFor(() => messages.some(m => m.t === 'state'));
    const state = messages.find(m => m.t === 'state');
    bridge.stop();
    for (const s of sockets) s.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
    return state;
  };
  const off = await make(false);
  assert.deepEqual(off.rooms, []);
  const onDefault = await make(undefined);
  assert.ok(Array.isArray(onDefault.rooms) && onDefault.rooms.length > 0, 'default rings reports rooms');
});
