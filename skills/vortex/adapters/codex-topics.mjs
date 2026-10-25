import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Consume only a contiguous run of the unread view: events above the ack
// watermark that no scoped ack already handled. `room`, the room a ring was
// charged to (VORTEX_ROOM), narrows the view to that room, so another room's
// ring budget never pays for this room's mail; the run is then acknowledged
// with that room's scope and never touches other rooms' mail.
export function topicBatch(snapshot,room) {
  const after=snapshot.acked??0;
  const handled=new Set(snapshot.handled??[]);
  const CONTROL_KINDS=new Set(['match','invitation','accepted','formed','arrival','departure','closed']);
  const events=snapshot.events.filter(e=>e.cursor>after&&!handled.has(e.cursor)&&(!room||e.room===room)&&!CONTROL_KINDS.has(e?.kind)).sort((a,b)=>a.cursor-b.cursor);
  if(!events.length)return null;
  // A direct message that core matched to a conference (routingConference)
  // shares that conference's thread but is still answered in its own room.
  // Any other direct message continues its direct room's one thread, so a run
  // of chatter is one model start, not one per message.
  const topic=e=>e.conference??e.routingConference;
  const key=e=>JSON.stringify(topic(e)?['conference',topic(e)]:['direct',e.room]);
  const first=events[0], route=key(first);
  const run=[];
  for(const event of events){if(key(event)!==route||event.room!==first.room)break;run.push(event);}
  return {key:route,after,through:run.at(-1).cursor,cursors:run.map(e=>e.cursor),room:first.room,conference:first.conference??null,routed:first.conference?null:(first.routingConference??null),session:first.session??'default',
    title:'VORTEX: '+String(first.statement??topic(first)??'direct from '+first.peer).slice(0,120)};
}

// thread/start records an empty thread. It starts no model and copies no history.
export async function createThread(title,timeoutMs,cwd=process.cwd()) {
  const child=spawn('codex',['app-server','--stdio'],{stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:child.stdout});
  let next=0;const pending=new Map();
  const rejectAll=error=>{for(const p of pending.values())p.reject(error);pending.clear();};
  child.on('error',rejectAll);
  child.on('exit',()=>rejectAll(Error('Codex app server exited before thread creation')));
  child.stderr.resume();
  lines.on('line',line=>{
    let reply;try{reply=JSON.parse(line);}catch{return;}
    const p=pending.get(reply.id);if(!p)return;pending.delete(reply.id);
    if(reply.error)p.reject(Error(reply.error.message));else p.resolve(reply.result);
  });
  const request=(method,params)=>new Promise((resolve,reject)=>{
    const id=++next;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params})+'\n');
  });
  const timer=setTimeout(()=>{rejectAll(Error('Codex thread creation timed out'));child.kill('SIGKILL');},timeoutMs);
  try {
    await request('initialize',{clientInfo:{name:'vortex_topics',title:'VORTEX topics',version:'1'},capabilities:null});
    child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
    const result=await request('thread/start',{cwd});
    const id=result?.thread?.id;
    if(typeof id!=='string'||!id)throw Error('Codex returned no thread id');
    await request('thread/name/set',{threadId:id,name:title});
    return id;
  } finally {clearTimeout(timer);lines.close();child.stdin.end();child.kill();}
}

export async function threadFor(dir,batch,timeoutMs,cwd) {
  const file=join(dir,'codex-topics.json');
  let routes={};
  try {routes=JSON.parse(readFileSync(file,'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw error;}
  if(routes[batch.key])return routes[batch.key];
  const thread=await createThread(batch.title,timeoutMs,cwd);
  routes[batch.key]=thread;
  // Persist before queueing so a retry cannot create a second destination.
  writeFileSync(file+'.tmp',JSON.stringify(routes),{mode:0o600});renameSync(file+'.tmp',file);
  return thread;
}
