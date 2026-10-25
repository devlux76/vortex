import { createConnection, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import type { Conversations } from './core/conversations.ts';

/**
 * `room` is the hash the router charged; `name` is that room locally (never
 * sent to the router), so the adapter handles the mail the ring paid for.
 * `unread` counts every room; `roomUnread` only the charged one.
 */
export interface RingRequest { ring: string; room: string; name: string; roomUnread: number; unread: number }
export interface BackboneOptions {
  path: string;
  owner: string;
  token: string;
  quietMs: number;
  core: Conversations;
  present?: () => boolean;
  rings?: boolean;
  onRing(request: RingRequest): void;
  onError(message: string): void;
}

const key=(room:string)=>createHash('sha256').update(room).digest('hex');

/** A body-free subscriber to the local OTP scheduler. Mail remains in the core. */
export function connectBackbone(options: BackboneOptions) {
  let socket: Socket | undefined;
  let ready=false;
  let stopped=false;
  let running:string|null=null;
  let pending:string|null=null;
  let lastExit:{t:'exited';ring:string;code:number}|undefined;
  let lastActivity=-Infinity;
  let reconnect:ReturnType<typeof setTimeout>|undefined;
  let delay=100;
  let updateQueued=false;
  let embedCounter=0;
  const pendingEmbeds=new Map<string,{resolve:(value:Float32Array)=>void;reject:(error:Error)=>void}>();
  const rejectPendingEmbeds=(reason:string)=>{
    for(const [id,pending] of pendingEmbeds) {
      pendingEmbeds.delete(id);
      pending.reject(new Error(reason));
    }
  };
  const send=(message:unknown)=>{
    if(ready && socket && !socket.destroyed) socket.write(JSON.stringify(message)+'\n');
  };
  const state=()=>{
    const snapshot=options.core.notificationState();
    const rooms=options.rings===false?[]:snapshot.rooms.filter(room=>room.hasData).map(({room,hasData,...rest})=>({room:key(room),...rest}));
    send({t:'state',waiters:snapshot.waiters+(options.present?.()?1:0),running,rooms});
  };
  // Coalesce synchronous core changes, letting a delivered wait's owner
  // activity reach the router before its waiter-detached snapshot.
  const update=()=>{
    if(updateQueued || stopped) return;
    updateQueued=true;
    queueMicrotask(()=>{updateQueued=false;if(!stopped) state();});
  };
  const off=options.core.onChange(update);
  const stop=()=>{
    stopped=true; ready=false; clearTimeout(reconnect); off(); rejectPendingEmbeds('backbone stopped'); socket?.destroy();
  };
  const connect=()=>{
    if(stopped) return;
    const current=createConnection({path:options.path});
    socket=current;
    let buffer='';
    current.on('connect',()=>{
      current.write(JSON.stringify({t:'hello',v:1,owner:options.owner,token:options.token,quiet_ms:options.quietMs})+'\n');
    });
    current.on('error',error=>options.onError(`backbone connection: ${error.message}`));
    current.on('close',()=>{
      if(socket!==current) return;
      ready=false; pending=null;
      rejectPendingEmbeds('backbone disconnected');
      if(!stopped) {
        reconnect=setTimeout(connect,delay);
        delay=Math.min(delay*2,5000);
      }
    });
    current.on('data',chunk=>{
      buffer+=chunk.toString('utf8');
      if(buffer.length>131072) {options.onError('backbone message exceeds size limit');current.destroy();return;}
      let at:number;
      while((at=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,at);buffer=buffer.slice(at+1);
        let message:any;
        try {message=JSON.parse(line);} catch {options.onError('invalid backbone JSON');continue;}
        if(message?.t==='welcome' && !ready) {
          ready=true; delay=100;
          // Replay is idempotent by ring ID. Preserve exit accounting if a
          // connection failed before the router received the original exit.
          if(lastExit) send(lastExit);
          if(Date.now()-lastActivity<options.quietMs) send({t:'acted'});
          state();
        } else if(message?.t==='error') {
          options.onError(`backbone registration rejected: ${String(message.reason)}`);
          if(message.reason==='owner_attached') current.destroy();
          else stop();
        } else if(message?.t==='ring' && ready) {
          if(typeof message.ring!=='string' || !message.ring || message.ring.length>64 ||
            typeof message.room!=='string' || !/^[a-f0-9]{64}$/.test(message.room) ||
            !Number.isSafeInteger(message.unread) || message.unread<1) {
            options.onError('invalid backbone ring');continue;
          }
          if(message.ring===running || message.ring===pending) continue;
          const snapshot=options.core.notificationState();
          const room=snapshot.rooms.find(room=>key(room.room)===message.room);
          if(running || pending || snapshot.waiters>0 || options.present?.() || !room || Date.now()-lastActivity<options.quietMs) {
            send({t:'refused',ring:message.ring});state();continue;
          }
          pending=message.ring;
          options.onRing({ring:message.ring,room:message.room,name:room.room,roomUnread:room.unread,
            unread:snapshot.rooms.reduce((n,room)=>n+room.unread,0)});
        } else if(message?.t==='embedded') {
          const pending=pendingEmbeds.get(message?.id);
          if(pending) {
            pendingEmbeds.delete(message.id);
            const vector=message?.vector;
            if(!Array.isArray(vector) || vector.length!==768 || !vector.every(x=>typeof x==='number'&&Number.isFinite(x))) {
              pending.reject(new Error(`backbone embedded vector is not 768 finite numbers`));
            } else {
              pending.resolve(Float32Array.from(vector));
            }
          }
        } else if(message?.t==='embed_error') {
          const pending=pendingEmbeds.get(message?.id);
          if(pending) {
            pendingEmbeds.delete(message.id);
            pending.reject(new Error('backbone embed failed: '+(message.reason==='busy'||message.reason==='unavailable'?message.reason:'error')));
          }
        }
      }
    });
  };
  connect();
  // The router drops an over-long request without a reply, so bound it here (wire.ex: 1..65536 bytes).
  const embed=(text:string):Promise<Float32Array>=>{
    if(stopped) return Promise.reject(new Error('backbone stopped'));
    const bytes=Buffer.byteLength(text,'utf8');
    if(bytes<1||bytes>65536) return Promise.reject(new Error('embed text must contain 1 to 65536 bytes'));
    if(!ready || !socket || socket.destroyed) return Promise.reject(new Error('backbone not connected'));
    const id=`embed-${++embedCounter}`;
    return new Promise<Float32Array>((resolve,reject)=>{
      pendingEmbeds.set(id,{resolve,reject});
      send({t:'embed',id,text});
    });
  };
  return {
    embed,
    changed: update,
    acted() {lastActivity=Date.now();send({t:'acted'});},
    // Fresh connection state for CLI info: completed welcome only, never socket-open alone.
    status() {return {connected:ready};},
    started(ring:string) {running=ring;pending=null;send({t:'started',ring});state();},
    refused(ring:string) {if(pending===ring) pending=null;send({t:'refused',ring});state();},
    exited(ring:string,code:number) {
      if(running===ring) running=null;
      if(pending===ring) pending=null;
      lastExit={t:'exited',ring,code};send(lastExit);state();
    },
    stop
  };
}
