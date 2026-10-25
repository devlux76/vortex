// Head-of-line regression (2026-10-23), end to end over two real services.
// A stale direct message sat at the head of Claude's queue; the
// `attach --next --session live` line claimed only a head its session owned,
// so it never woke for the live conference mail behind it, and an unscoped
// ack through that mail would have discarded the foreign message.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pause=(ms=20)=>new Promise(r=>setTimeout(r,ms));

// Deterministic 768-dimensional vectors: equal text gives an equal vector
// (an exact match), unrelated text gives a near-orthogonal one (no route).
function vector(text:string):number[] {
  const out:number[]=[];
  for(let block=0;out.length<768;block++) {
    const digest=createHash('sha256').update(`${block}:${text}`).digest();
    for(let i=0;i<digest.length&&out.length<768;i+=2) out.push((digest.readUInt16BE(i)/65535)*2-1);
  }
  return out;
}

// A wake router stand-in: welcomes owners, embeds text, and records each
// owner's latest ring state (what the real router decides rings from). It
// never rings, so the no-op adapter below is never started.
async function fakeRouter(path:string) {
  const sockets:Socket[]=[];
  const states=new Map<string,{waiters:number;running:boolean;rooms:{room:string;unread:number}[]}>();
  const server=createServer(socket=>{
    sockets.push(socket);
    let buffer='',owner='';
    socket.on('data',chunk=>{
      buffer+=chunk.toString();
      let at:number;
      while((at=buffer.indexOf('\n'))>=0) {
        const message=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);
        if(message.t==='hello') {owner=message.owner;socket.write('{"t":"welcome"}\n');}
        else if(message.t==='state') states.set(owner,message);
        else if(message.t==='embed') socket.write(JSON.stringify({t:'embedded',id:message.id,vector:vector(message.text)})+'\n');
      }
    });
  });
  await new Promise<void>(resolve=>server.listen(path,resolve));
  return {states,close:async()=>{for(const s of sockets) s.destroy();await new Promise<void>(r=>server.close(()=>r()));}};
}
// Ringable for the router: nobody claims it (waiters 0), no adapter running,
// and exactly the expected rooms hold unread mail.
const ringable=(state:{waiters:number;running:boolean;rooms:{room:string;unread:number}[]}|undefined,rooms:number)=>
  state!==undefined&&state.waiters===0&&!state.running&&state.rooms.filter(r=>r.unread>0).length===rooms;

test('live: a scoped line keeps waiting through a foreign head, wakes for its own conference post behind it, and its ack loses nothing', {timeout:60000}, async()=>{
  const root=mkdtempSync(join(tmpdir(),'vortex-hol-'));
  const processes:ChildProcess[]=[];
  const sock=join(root,'router.sock');
  const router=await fakeRouter(sock);
  try {
    const start=async(name:string)=>{
      const dir=join(root,name),file=join(dir,'endpoint.json');
      const child=spawn('bun',['src/cli.ts','serve','--dir',dir,'--name',name,'--port','0','--semantic','--backbone',sock,'--on-ring','/bin/true'],{stdio:'ignore'});
      processes.push(child);
      const end=Date.now()+10000;
      while(!existsSync(file)){assert.equal(child.exitCode,null,'service exited');assert.ok(Date.now()<end,'service start');await pause();}
      const ep=JSON.parse(readFileSync(file,'utf8'));
      const call=async(op:string,args:unknown={})=>{
        const r=await fetch(ep.url+'/'+op,{method:'POST',headers:{authorization:'Bearer '+ep.token,'content-type':'application/json'},body:JSON.stringify(args)});
        const value:any=await r.json();assert.equal(r.status,200,`${op}: ${JSON.stringify(value)}`);return value;
      };
      const until=async<T>(what:string,check:()=>Promise<T|undefined>,ms=10000):Promise<T>=>{
        const end=Date.now()+ms;
        for(;;){const v=await check();if(v!==undefined) return v;assert.ok(Date.now()<end,what);await pause(50);}
      };
      return {dir,call,until};
    };
    const a=await start('a'),b=await start('b');
    const bi=await b.call('info');
    await a.call('dial',{peer:bi.addrs[0]});
    const {room}=await a.call('invite',{peer:bi.peerId});
    await b.until('invitation',async()=>(await b.call('read')).events.some((e:any)=>e.kind==='invitation')||undefined);
    await b.call('accept',{room});

    // a hosts a topic under session live; b joins it by announcing the same problem.
    const statement='head-of-line regression topic';
    const created=await a.call('create',{statement,session:'live',admission:'open'});
    const conference:string=created.conference.id;
    assert.match(conference,/^[0-9a-f]{32}$/);
    const {id:interest}=await b.call('announce',{statement,session:'s'});
    assert.ok(interest);
    const match=await b.until('match',async()=>(await b.call('read')).events.find((e:any)=>e.kind==='match'&&e.record===conference),20000);
    assert.equal(match.record,conference);
    await b.call('join',{ref:conference,session:'s'});
    await a.until('arrival',async()=>(await a.call('read')).events.some((e:any)=>e.kind==='arrival')||undefined);
    await a.call('ack',{cursor:(await a.call('read')).cursor});
    assert.equal((await a.call('read')).events.length,0,'setup mail acknowledged');

    // The foreign head: a direct message that routes to no conference.
    await b.call('send',{room,text:'stale automatic ring reply, unrelated'});
    const head=await a.until('foreign head',async()=>(await a.call('read')).events.find((e:any)=>e.kind==='message'));
    assert.equal(head.routingConference,undefined,'the direct message is not routed to the topic');

    const line=spawn('bun',['src/cli.ts','attach','--dir',a.dir,'--next','--session','live'],{stdio:['ignore','pipe','pipe']});processes.push(line);
    let output='';line.stdout!.on('data',chunk=>output+=chunk);
    await a.until('line attached',async()=>output.includes('\n')||undefined);
    assert.deepEqual(JSON.parse(output.split('\n')[0]),{attached:true,cursor:head.cursor,unread:0},'the foreign head is not the line\'s');
    await pause(300);
    assert.equal(line.exitCode,null,'the line keeps waiting through the foreign head');
    assert.equal((await a.call('info')).presence.present,false,'the scoped line does not claim the foreign head');
    await a.until('router told the foreign room is ringable',async()=>ringable(router.states.get('a'),1)||undefined);

    // The owned post behind it wakes the line (this is what never happened).
    await b.call('post',{conference,text:'owned topic mail behind the foreign head',session:'s'});
    await a.until('line woke',async()=>line.exitCode===0||undefined);
    const notice=JSON.parse(output.trim().split('\n').at(-1)!);
    assert.equal(notice.unread,1);
    const mine=(await a.call('read',{session:'live'})).events;
    assert.deepEqual(mine.map((e:any)=>e.kind),['conference_message']);
    assert.ok(mine[0].cursor>head.cursor,'the owned event sits behind the foreign head');

    // The scoped ack handles only the owned event; the foreign one survives.
    await a.call('ack',{cursor:mine[0].cursor,session:'live'});
    assert.deepEqual((await a.call('read')).events.map((e:any)=>e.cursor),[head.cursor],'the foreign message is still unread');
    assert.deepEqual((await a.call('read',{session:'live'})).events,[]);
    const saved=JSON.parse(readFileSync(join(a.dir,'state.json'),'utf8'));
    assert.deepEqual(saved.handled,[mine[0].cursor],'the handled set is durable');
    assert.equal(saved.acked,head.cursor-1,'the watermark did not pass the foreign event');
    await a.until('after the scoped ack the router still sees only the foreign room ringable',
      async()=>ringable(router.states.get('a'),1)||undefined);
  } finally {
    await Promise.all(processes.filter(p=>p.exitCode===null&&p.signalCode===null).map(p=>new Promise<void>(r=>{p.once('exit',()=>r());p.kill('SIGTERM');})));
    await router.close();
    rmSync(root,{recursive:true,force:true});
  }
});
