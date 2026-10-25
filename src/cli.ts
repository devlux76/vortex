import { createServer, request as httpRequest } from 'node:http';
import { mkdirSync, existsSync, readFileSync, writeFileSync, writeSync, renameSync, chmodSync, accessSync, constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { parseArgs } from 'node:util';
import { spawn, type ChildProcess } from 'node:child_process';
import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import { createNodeTransport } from './net/node.ts';
import { startWsBridge } from './net/ws-bridge.ts';
import { VortexService, type ConferenceFeedback } from './core/service.ts';
import type { Snapshot } from './core/conversations.ts';
import { connectBackbone } from './backbone.ts';
import { createBackboneEmbedder } from './embed/gguf.ts';
import { Presence, selfHostPid } from './presence.ts';
import { connectBootstrap } from './bootstrap.ts';
import { createLazyGemmaEmbedder } from './embed/gemma.ts';
import { loadDisclosurePolicy } from './disclosure-config.ts';

/** Print a JSON argument error on stdout and exit non-zero (writeSync: already flushed). */
const failJson = (body: { error: string, got: string, example: string }): never => {
  writeSync(1, JSON.stringify(body) + '\n');
  process.exit(1);
};

// Owner feedback never accepts caller-supplied provenance or embeddings.
function feedbackArgs(args: Record<string, unknown>): ConferenceFeedback | undefined {
  if (args.outcomes === undefined) {
    if (args.statement !== undefined) throw Error('feedback statement requires outcomes');
    return undefined;
  }
  const outcomes = args.outcomes;
  if (!Array.isArray(outcomes) || outcomes.length < 1 || outcomes.length > 256) throw Error('invalid feedback outcomes');
  const seen = new Set<string>();
  for (const entry of outcomes) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).some(key => key !== 'participant' && key !== 'outcome') ||
        typeof entry.participant !== 'string' || !/^[0-9a-f]{64}$/.test(entry.participant) ||
        !['useful', 'neutral', 'misleading'].includes(entry.outcome) || seen.has(entry.participant))
      throw Error('invalid feedback outcomes');
    seen.add(entry.participant);
  }
  if (args.statement !== undefined && (typeof args.statement !== 'string' || !args.statement.length ||
      Buffer.byteLength(args.statement) > 4096)) throw Error('invalid feedback statement');
  return { outcomes, ...(args.statement === undefined ? {} : { statement: args.statement as string }) };
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// A --peer is either a bare peer id or a multiaddr that parses and ends in
// /p2p/<peer id>. Returns the one-sentence problem, or null when valid.
function peerProblem (value: string | undefined): string | null {
  if (value === undefined) return '--peer is missing: give the peer id or its multiaddr';
  try { peerIdFromString(value); return null; } catch { /* not a bare peer id */ }
  const idx = value.lastIndexOf('/p2p/');
  if (idx >= 0) {
    const tail = value.slice(idx + 5);
    let n = 0;
    while (n < tail.length && BASE58.includes(tail[n])) n++;
    const rest = tail.slice(n);
    if (rest.length > 0) return `--peer has extra characters after the peer id: '${rest.slice(0, 60)}'`;
    if (n === 0) return '--peer is missing the peer id after /p2p/';
    try { peerIdFromString(tail); } catch { return '--peer has an invalid peer id after /p2p/'; }
    try { multiaddr(value); return null; } catch { return '--peer address is not a valid multiaddr ending in /p2p/<peer id>'; }
  }
  try {
    multiaddr(value);
    return '--peer address does not end in /p2p/<peer id>';
  } catch {
    return '--peer is neither a peer id nor a valid multiaddr';
  }
}

// A --room is the JSON array of two peer ids the service printed at invite time.
function roomProblem (value: string | undefined): string | null {
  if (value === undefined) return '--room is missing: give the conversation room';
  try {
    const room = JSON.parse(value);
    if (Array.isArray(room) && room.length === 2 && typeof room[0] === 'string' && typeof room[1] === 'string') return null;
    return '--room must be a JSON array of two peer ids';
  } catch {
    return '--room is not valid JSON';
  }
}

const ROOM_EX = `'["12D3KooWAAA","12D3KooWBBB"]'`;
const ID_EX = `'${'a'.repeat(32)}'`;
const HEX_ID = /^[0-9a-f]{32}$/;
// An --id or --replaces naming an announcement, or null when valid.
function idProblem (value: string | undefined, flag: string): string | null {
  if (value === undefined) return `${flag} is missing: give the announcement id`;
  if (!HEX_ID.test(value)) return `${flag} must be 32 lowercase hexadecimal characters`;
  return null;
}
// A --ttl in seconds, or null when valid.
function ttlProblem (value: string | undefined): string | null {
  if (value === undefined) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 3600) return '--ttl must be an integer from 1 to 3600 seconds';
  return null;
}
// A subscription --ttl in seconds: required, bounded by the absolute operator maximum (604800).
// The service enforces its own configured maximum on top.
function subscriptionTtlProblem (value: string | undefined): string | null {
  if (value === undefined) return '--ttl is missing: give the subscription lifetime in seconds';
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 604800) return '--ttl must be an integer from 1 to 604800 seconds';
  return null;
}
// The cursor of the last event a read or wait returned, for `ack --cursor read`.
let lastDelivered = 0;
const delivered = <T extends { cursor: number }>(page: T): T => { lastDelivered = Math.max(lastDelivered, page.cursor); return page; };

function validateArgs (op: string, v: { peer?: string, room?: string, text?: string, cursor?: string,
  statement?: string, session?: string, ttl?: string, capacity?: string, admission?: string, 'admission-peer'?: string[], replaces?: string, id?: string, ref?: string, conference?: string, type?: string, 'reply-to'?: string, after?: string, limit?: string }): { error: string, got: string, example: string } | null {
  switch (op) {
    case 'dial':
    case 'invite': {
      const problem = peerProblem(v.peer);
      if (problem) return { error: problem, got: (v.peer ?? '').slice(0, 200),
        example: op === 'dial'
          ? 'bun src/cli.ts dial --peer /ip4/127.0.0.1/tcp/7800/p2p/12D3KooWAAA --dir .vortex/alice'
          : 'bun src/cli.ts invite --peer 12D3KooWAAA --dir .vortex/alice' };
      return null;
    }
    case 'send': {
      // --peer names the other side directly; the room follows from the two peer ids.
      const problem = v.room === undefined && v.peer !== undefined ? peerProblem(v.peer) : roomProblem(v.room);
      const example = `bun src/cli.ts send --room '${ROOM_EX}' --text 'hello' --dir .vortex/alice`;
      if (problem) return { error: problem, got: (v.room ?? v.peer ?? '').slice(0, 200), example };
      if (v.text === undefined) return { error: '--text is missing: give the message to send', got: '', example };
      return null;
    }
    case 'accept': {
      const problem = roomProblem(v.room);
      if (problem) return { error: problem, got: (v.room ?? '').slice(0, 200),
        example: `bun src/cli.ts accept --room '${ROOM_EX}' --dir .vortex/alice` };
      return null;
    }
    case 'ack': {
      const example = 'bun src/cli.ts ack --cursor 12 --dir .vortex/alice';
      if (v.cursor === undefined) return { error: '--cursor is missing: give the cursor to acknowledge', got: '', example };
      if (v.cursor === 'read') return null; // everything the last read or wait returned
      if (!Number.isFinite(Number(v.cursor))) return { error: '--cursor must be a number', got: v.cursor.slice(0, 200), example };
      return null;
    }
    case 'announce': {
      const example = `bun src/cli.ts announce --statement 'flaky tests' --dir .vortex/alice (if the reply is lost, interests shows it with its id)`;
      if (v.statement !== undefined && v.text !== undefined)
        return { error: 'give either --statement or --text, not both', got: v.statement.slice(0, 200), example };
      if (v.statement === undefined && v.text === undefined)
        return { error: 'give --statement for a semantic announcement or --text for a legacy interest', got: '', example };
      if (v.statement !== undefined) {
        const ttl = ttlProblem(v.ttl);
        if (ttl) return { error: ttl, got: (v.ttl ?? '').slice(0, 200), example };
        if (v.replaces !== undefined) {
          const problem = idProblem(v.replaces, '--replaces');
          if (problem) return { error: problem, got: v.replaces.slice(0, 200), example };
        }
      }
      return null;
    }
    case 'create': {
      const example = "bun src/cli.ts create --statement 'flaky tests' --session work --capacity 4 --admission open --dir .vortex/alice";
      if (!v.statement) return { error: '--statement is missing: give the conference topic', got: '', example };
      if (v.capacity !== undefined && (!Number.isInteger(Number(v.capacity)) || Number(v.capacity) < 2 || Number(v.capacity) > 256))
        return { error: '--capacity must be an integer from 2 to 256', got: v.capacity.slice(0, 200), example };
      if (v.admission !== undefined && !['open', 'invitation', 'group'].includes(v.admission))
        return { error: '--admission must be open, invitation or group', got: v.admission.slice(0, 200), example };
      for (const peer of v['admission-peer'] ?? []) {
        try { peerIdFromString(peer); }
        catch { return { error: '--admission-peer must be a bare peer identity', got: peer.slice(0, 200), example }; }
      }
      if (v['admission-peer'] !== undefined && (v.admission ?? 'open') === 'open')
        return { error: '--admission-peer requires invitation or group admission', got: v['admission-peer'][0] ?? '', example };
      return null;
    }
    case 'join':
    case 'post':
    case 'history':
    case 'leave': {
      const flag = op === 'join' ? '--ref' : '--conference';
      const value = op === 'join' ? v.ref : v.conference;
      const example = `bun src/cli.ts ${op} ${flag} ${ID_EX}${op === 'post' ? " --text 'hello'" : ''} --dir .vortex/alice`;
      const problem = idProblem(value, flag);
      if (problem) return { error: problem, got: (value ?? '').slice(0, 200), example };
      if (op === 'history' && v.limit !== undefined && (!Number.isSafeInteger(Number(v.limit)) || Number(v.limit) < 1 || Number(v.limit) > 20))
        return { error: '--limit must be an integer from 1 to 20', got: v.limit.slice(0, 200), example };
      if (op === 'history' && v.after !== undefined && (!Number.isSafeInteger(Number(v.after)) || Number(v.after) < 0))
        return { error: '--after must be a non-negative safe integer history sequence', got: v.after.slice(0, 200), example };
      if (op === 'post' && v.text === undefined)
        return { error: '--text is missing: give the message to post', got: '', example };
      if (v.type !== undefined && !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(v.type))
        return { error: '--type must be 1–32 lowercase letters, digits, dots, underscores or hyphens, starting with a letter or digit', got: v.type.slice(0, 200), example };
      if (v['reply-to'] !== undefined) {
        const problem = idProblem(v['reply-to'], '--reply-to');
        if (problem) return { error: problem, got: v['reply-to'].slice(0, 200), example };
      }
      return null;
    }
    case 'interests': {
      return null;
    }
    case 'subscribe': {
      const example = `bun src/cli.ts subscribe --conference ${ID_EX} --session work --ttl 3600 --dir .vortex/alice`;
      const problem = idProblem(v.conference, '--conference');
      if (problem) return { error: problem, got: (v.conference ?? '').slice(0, 200), example };
      const ttl = subscriptionTtlProblem(v.ttl);
      if (ttl) return { error: ttl, got: (v.ttl ?? '').slice(0, 200), example };
      return null;
    }
    case 'subscriptions': {
      return null;
    }
    case 'unsubscribe': {
      const example = `bun src/cli.ts unsubscribe --conference ${ID_EX} --session work --dir .vortex/alice`;
      const problem = idProblem(v.conference, '--conference');
      if (problem) return { error: problem, got: (v.conference ?? '').slice(0, 200), example };
      return null;
    }
    case 'withdraw':
    case 'matches': {
      const example = `bun src/cli.ts ${op} --id ${ID_EX} --dir .vortex/alice`;
      const problem = idProblem(v.id, '--id');
      if (problem) return { error: problem, got: (v.id ?? '').slice(0, 200), example };
      return null;
    }
    case 'revise': {
      const example = `bun src/cli.ts revise --conference ${ID_EX} --statement 'new topic' --session work --dir .vortex/alice`;
      const problem = idProblem(v.conference, '--conference');
      if (problem) return { error: problem, got: (v.conference ?? '').slice(0, 200), example };
      if (!v.statement) return { error: '--statement is missing: give the new conference topic', got: '', example };
      return null;
    }
    default: return null;
  }
}

const { values, positionals } = (() => {
try {
return parseArgs({ allowPositionals:true, options:{
  dir:{type:'string',default:'.vortex/codex'}, port:{type:'string',default:'7800'}, name:{type:'string',default:'codex'},
  bootstrap:{type:'string'}, for:{type:'string'}, peer:{type:'string'}, room:{type:'string'}, text:{type:'string'}, after:{type:'string'},
  cursor:{type:'string'}, timeout:{type:'string',default:'30'}, 'on-ring':{type:'string'},
  'ring-quiet-ms':{type:'string',default:'30000'}, 'p2p-port':{type:'string',default:'0'}, backbone:{type:'string',default:'.vortex/backbone/router.sock'},
  'ws-port':{type:'string'}, 'ws-origin':{type:'string',multiple:true},
  'conference-history-limit':{type:'string',default:'256'}, 'conference-history-bytes':{type:'string',default:'1048576'}, limit:{type:'string'},
  'subscription-limit':{type:'string',default:'32'}, 'subscription-max-ttl':{type:'string',default:'86400'},
  'history-limit':{type:'string',default:'1000'}, 'dedup-limit':{type:'string',default:'4096'},
  'peer-memory-ttl':{type:'string',default:'2592000'}, 'peer-memory-limit':{type:'string',default:'128'},
  'peer-memory-bytes':{type:'string',default:'8388608'},
  'disclosure-policy':{type:'string'},
  next:{type:'boolean',default:false}, 'host-pid':{type:'string'},
  semantic:{type:'boolean',default:false}, statement:{type:'string'}, outcomes:{type:'string'}, session:{type:'string'}, ttl:{type:'string'},
  'publish-statement':{type:'boolean',default:false}, replaces:{type:'string'}, id:{type:'string'},
  capacity:{type:'string'}, admission:{type:'string'}, 'admission-peer':{type:'string',multiple:true},
  ref:{type:'string'}, conference:{type:'string'}, type:{type:'string'}, 'reply-to':{type:'string'}
}});
} catch (e) {
if (process.argv.some(arg => arg === '--outcomes' || arg.startsWith('--outcomes=')) ||
    (process.argv.some(arg => ['leave','unsubscribe','withdraw'].includes(arg)) &&
      process.argv.some(arg => arg === '--statement' || arg.startsWith('--statement='))))
  failJson({error:'could not parse private feedback arguments',got:'',example:'bun src/cli.ts leave --conference <id> --dir .vortex/local'});
failJson({ error: `could not parse arguments: ${e instanceof Error ? e.message : String(e)}`,
  got: process.argv.slice(2).join(' ').slice(0, 200), example: 'bun src/cli.ts info --dir .vortex/alice' });
throw e;
}
})();
const dir=resolve(values.dir!);
const operation=positionals[0];
const endpointFile=join(dir,'endpoint.json');
const atomic=(path:string,value:unknown) => { writeFileSync(path+'.tmp',JSON.stringify(value),{mode:0o600}); renameSync(path+'.tmp',path); };
// JSON can expand each permitted body byte to a six-byte control escape.
const maxJsonBytes=6*16384+4096;

if (operation==='serve') {
  const disclosure=values['disclosure-policy'] ? loadDisclosurePolicy(resolve(values['disclosure-policy'])) : undefined;
  const historyLimit=Number(values['history-limit']), dedupLimit=Number(values['dedup-limit']);
  for(const flag of ['history-limit','dedup-limit'] as const) {
    if(values[flag]!.trim()==='' || !Number.isSafeInteger(Number(values[flag])) || Number(values[flag])<0)
      failJson({error:`--${flag} must be a non-negative safe integer`,got:values[flag]!.slice(0,200),
        example:`bun src/cli.ts serve --${flag} 1000 --dir .vortex/local`});
  }
  const subscriptionLimit=Number(values['subscription-limit']), subscriptionMaxTtl=Number(values['subscription-max-ttl']);
  if(values['subscription-limit']!.trim()==='' || !Number.isInteger(subscriptionLimit) || subscriptionLimit<1 || subscriptionLimit>128)
    failJson({error:'--subscription-limit must be an integer from 1 to 128',got:values['subscription-limit']!.slice(0,200),
      example:'bun src/cli.ts serve --subscription-limit 32 --dir .vortex/local'});
  if(values['subscription-max-ttl']!.trim()==='' || !Number.isInteger(subscriptionMaxTtl) || subscriptionMaxTtl<1 || subscriptionMaxTtl>604800)
    failJson({error:'--subscription-max-ttl must be an integer from 1 to 604800',got:values['subscription-max-ttl']!.slice(0,200),
      example:'bun src/cli.ts serve --subscription-max-ttl 86400 --dir .vortex/local'});
  const peerMemory={ttl:Number(values['peer-memory-ttl']),maxCount:Number(values['peer-memory-limit']),maxBytes:Number(values['peer-memory-bytes'])};
  for(const [flag,max] of [['peer-memory-ttl',31536000],['peer-memory-limit',4096],['peer-memory-bytes',67108864]] as const) {
    const value=values[flag]!;
    if(value.trim()==='' || !Number.isInteger(Number(value)) || Number(value)<1 || Number(value)>max)
      failJson({error:`--${flag} must be an integer from 1 to ${max}`,got:value.slice(0,200),example:`bun src/cli.ts serve --${flag} 1 --dir .vortex/local`});
  }
  const adapter=values['on-ring'] ? resolve(values['on-ring']) : undefined;
  if(adapter) accessSync(adapter,constants.X_OK);
  mkdirSync(dir,{recursive:true,mode:0o700}); chmodSync(dir,0o700);
  const keyFile=join(dir,'identity');
  const stateFile=join(dir,'state.json');
  const p2pPort=Number(values['p2p-port']);
  if(!Number.isInteger(p2pPort) || p2pPort<0 || p2pPort>65535) throw new Error('p2p port must be 0 to 65535');
  // A fixed peer port keeps the multiaddr stable across restarts, so peers that remember it can still deliver.
  const transport=await createNodeTransport({key:existsSync(keyFile)?readFileSync(keyFile):undefined,maxDirectBytes:maxJsonBytes,listen:[`/ip4/127.0.0.1/tcp/${p2pPort}`]});
  const restored=existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')) as Snapshot:undefined;
  const semantic=values.semantic===true;
  const bridgeRef: { current?: ReturnType<typeof connectBackbone> } = {};
  // --backbone has a default path; only an explicit flag selects the router's shared embedder.
  const backboneGiven=process.argv.some(arg=>arg==='--backbone'||arg.startsWith('--backbone='));
  const embedder = semantic
    ? (backboneGiven
        ? createBackboneEmbedder({ embed: (text: string) => {
            if (!bridgeRef.current) throw new Error('backbone not connected');
            return bridgeRef.current.embed(text);
          } })
        : createLazyGemmaEmbedder())
    : undefined;
  const service=new VortexService(transport,values.name!,s=>atomic(stateFile,s),restored,
    {retention:{historyLimit,dedupLimit},disclosure,peerMemory,
      conferences:{historyLimit:Number(values['conference-history-limit']),historyBytes:Number(values['conference-history-bytes'])},
      subscriptions:{maxCount:subscriptionLimit,maxTtl:subscriptionMaxTtl},
      ...(semantic?{embedder:embedder!,onError:message=>console.error(message)}:{})});
  const startInfo=await service.start();
  let wsBridge:Awaited<ReturnType<typeof startWsBridge>>|undefined;
  let wsAddr:string|undefined;
  if(values['ws-port']!==undefined){
    const requestedWsPort=Number(values['ws-port']);
    if(!Number.isFinite(requestedWsPort)||requestedWsPort<0||requestedWsPort>65535) throw new Error('ws-port must be 0-65535');
    const tcpAddr=startInfo.addrs.find(a=>a.startsWith('/ip4/127.0.0.1/tcp/'));
    if(!tcpAddr) throw new Error('no loopback TCP listen address to bridge');
    const tcpPort=Number(tcpAddr.split('/')[4]);
    const origins=Array.isArray(values['ws-origin'])?values['ws-origin'] as string[]:values['ws-origin']!==undefined?[values['ws-origin'] as string]:[];
    wsBridge=await startWsBridge({port:requestedWsPort,tcpPort,origins});
    wsAddr=`/ip4/127.0.0.1/tcp/${wsBridge.port}/ws/p2p/${startInfo.peerId}`;
    const origInfo=service.info.bind(service);
    service.info=()=>{const i=origInfo(); return i.addrs.includes(wsAddr!)?i:{...i,addrs:[...i.addrs,wsAddr!]};};
  }
  const info=service.info();
  const ownerQuietMs=Number(values['ring-quiet-ms']);
  if(!Number.isFinite(ownerQuietMs) || ownerQuietMs<0) throw new Error('ring quiet interval must be non-negative');
  let ringProcess:ChildProcess | undefined;
  let bridge:ReturnType<typeof connectBackbone>|undefined;
  const presence=new Presence(dir,()=>bridge?.changed());
  // A desktop app process/CLI stream cannot resume an idle model turn. In
  // explicit foreground mode the queue adapter owns admission, not presence.
  const foregroundDelivery=values.name==='codex'&&Boolean(process.env.VORTEX_CODEX_FOREGROUND_THREAD);
  // The session that owns an event's topic, if any: its conference's session,
  // or for a routed direct message the session holding that conference. A
  // session-scoped attach line is woken for every unread event its session
  // owns, wherever it sits in the queue; an unowned head rings the adapter
  // (one topic = one thread).
  const ownerOf=(event:{conference?:string;routingConference?:string;session?:string}):string|undefined=>{
    if(event.conference!==undefined) return event.session;
    if(event.routingConference===undefined) return undefined;
    try {return service.conferenceList().find(c=>c.id===event.routingConference)?.session;}
    catch {return undefined;}
  };
  const headSession=():string|undefined=>{
    const head=service.core().head();
    return head?ownerOf(head):undefined;
  };
  const scope=(args:{session?:unknown;room?:unknown}):((e:{room:string;conference?:string;routingConference?:string;session?:string})=>boolean)|undefined=>{
    if(args.room!==undefined&&(typeof args.room!=='string'||!args.room)) throw Error('room must be a non-empty string');
    if(args.session===undefined&&args.room===undefined) return undefined;
    return e=>(args.session===undefined||ownerOf(e)===args.session)&&(args.room===undefined||e.room===args.room);
  };
  const unreadOwners=()=>service.core().unreadTopics().map(t=>({cursor:t.cursor,owner:ownerOf(t)}));
  let announced=service.core().notice().cursor;
  const offPresence=service.core().onEvents(()=>{
    const notice=service.core().notice();
    const unread=unreadOwners();
    while(announced<notice.cursor) {
      announced++;
      presence.notify({cursor:announced,unread:Math.max(0,notice.unread-(notice.cursor-announced))},unread);
    }
    // Scoped lines also hear about owned mail an ack or a late route exposed.
    presence.notify(undefined,unread);
  });
  const attachments=new Set<()=>void>();
  let lastExitCode:number|null=null;
  let refusedRings=0;
  let stopBootstrap:(() => void)|undefined;
  writeFileSync(keyFile,transport.exportKey(),{mode:0o600});
  const token=randomBytes(32).toString('hex');
  const server=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    const reply=(status:number,result:unknown)=>{res.statusCode=status;res.end(JSON.stringify(result));};
    const supplied=Buffer.from(req.headers.authorization??'');
    const expected=Buffer.from('Bearer '+token);
    if (req.method!=='POST' || supplied.length!==expected.length || !timingSafeEqual(supplied,expected)) {
      reply(403,{error:'authenticated local POST required'}); return;
    }
    try {
      const chunks:Buffer[]=[]; let size=0;
      for await(const chunk of req) { size+=chunk.length; if(size>maxJsonBytes) throw new Error('request too large'); chunks.push(chunk); }
      const args=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!args || typeof args!=='object' || Array.isArray(args)) throw new Error('expected object');
      let result:unknown;
      switch(req.url) {
        case '/info': result={...service.info(),presence:presence.info(service.core().waiters(),headSession()),wake:{configured:adapter!==undefined,
          adapter:adapter??null,rings:adapter!==undefined,
          refusedRings,
          routerConnected:bridge?.status().connected??false,
          adapterRunning:ringProcess!==undefined,lastExitCode},
          semantic:semantic?{enabled:true,namespace:service.semanticNamespace()}:{enabled:false},
          disclosure:{configured:disclosure!==undefined},peerMemory:{...peerMemory,...service.peerMemoryStats()}}; break;
        case '/attach': {
          if(args.next!==undefined&&typeof args.next!=='boolean') throw Error('next must be boolean');
          if(args.session!==undefined&&(typeof args.session!=='string'||!args.session||args.session.length>128)) throw Error('session must contain 1 to 128 characters');
          let detach:()=>void=()=>{};
          const close=()=>{attachments.delete(close);detach();if(!res.destroyed) res.end();};
          const write=(notice:{cursor:number;unread:number},initial=false)=>{
            if(res.destroyed) {close();return;}
            res.write(JSON.stringify({...(initial?{attached:true}:{}),...notice})+'\n');
            if(notice.unread>0) bridge?.acted();
            if(args.next&&notice.unread>0) close();
            else if(res.writableLength>maxJsonBytes) res.destroy();
          };
          // A scoped line's first notice counts only the unread mail it owns.
          const initial=service.core().notice();
          const owned=args.session===undefined?[]:unreadOwners().filter(u=>u.owner===args.session);
          detach=presence.attach(notice=>write(notice),args.hostPid,args.session,owned.at(-1)?.cursor);
          attachments.add(close);res.once('close',close);
          res.setHeader('Content-Type','application/x-ndjson');
          res.setHeader('Cache-Control','no-store');
          res.setTimeout(0);res.flushHeaders();
          write(args.session===undefined?initial:{cursor:initial.cursor,unread:owned.length},true);
          return;
        }
        case '/announce': {
          if (args.statement !== undefined) {
            const { id, expires } = await service.announceStatement({ session: args.session ?? 'default',
              statement: args.statement, ttl: args.ttl, publishStatement: args.publishStatement,
              replaces: args.replaces });
            result = { announced: true, id, expires };
          } else { await service.announce(args.text); result = { announced: true }; }
          break;
        }
        case '/interests': result={interests:service.openInterests(args.session)}; break;
        case '/withdraw': if(args.outcomes!==undefined || args.statement!==undefined) throw Error('feedback requires conference or subscription leave'); result={withdrawn:service.withdrawInterest(args.session ?? 'default',args.id)}; break;
        case '/matches': result={matches:service.matchesFor(args.id),trust:'untrusted_peer_content'}; break;
        case '/create': result={created:true,conference:await service.createConference({session:args.session ?? 'default',
          statement:args.statement,capacity:args.capacity,admission:args.admission,peers:args.peers})}; break;
        case '/join': result={joined:true,conference:await service.joinConference({session:args.session ?? 'default',ref:args.ref},20000)}; break;
        case '/post': result=await service.postToConference({session:args.session ?? 'default',conference:args.conference,
          text:args.text,type:args.type,replyTo:args.replyTo}); break;
        case '/history': {
          const canceled=new AbortController();
          const closed=()=>canceled.abort();
          res.once('close',closed);
          try { result=await service.conferenceHistory({session:args.session ?? 'default',conference:args.conference,
            after:args.after,limit:args.limit,timeout:args.timeout},canceled.signal); }
          finally { res.off('close',closed); }
          break;
        }
        case '/leave': result={left:await service.leaveConference(args.session ?? 'default',args.conference,feedbackArgs(args))}; break;
        case '/revise': result={revised:true,conference:await service.reviseConference({session:args.session ?? 'default',
          conference:args.conference,statement:args.statement})}; break;
        case '/subscribe': result={subscription:await service.subscribeConference({session:args.session ?? 'default',
          conference:args.conference,ttl:args.ttl})}; break;
        case '/subscriptions': result={subscriptions:service.subscriptions(args.session)}; break;
        case '/unsubscribe': result={unsubscribed:await service.unsubscribeConference(args.session ?? 'default',args.conference,feedbackArgs(args))}; break;
        case '/conferences': result={conferences:service.conferenceList(args.session)}; break;
        case '/discover': result={peers:service.discover(),mode:'authenticated-directory; no semantic ranking yet'}; break;
        case '/dial': result={peer:await service.dial(args.peer)}; break;
        case '/invite': result={room:await service.core().invite(args.peer)}; break;
        case '/inbox': result={rooms:service.core().rooms()}; break;
        case '/accept': await service.core().accept(args.room); result={accepted:true}; break;
        case '/send': {
          // An invitation just sent is usually accepted within a second; wait briefly rather than fail a send issued straight after it.
          const room=args.room ?? service.core().roomFor(String(args.peer).split('/p2p/').pop()!);
          const pending=() => { const r=service.core().rooms()[room]; return r?.localConsent===true && !r.remoteConsent; };
          for(let i=0;i<40 && pending();i++) await new Promise(r=>setTimeout(r,200));
          await service.core().send(room,args.text);
        } result={sent:true,delivery:'transport-write; not application receipt'}; break;
        // --session and/or --room: only that session's topics, or only that
        // room (a rung adapter's charged room), so a scoped reader neither sees
        // nor acknowledges any other mail.
        case '/read': result=delivered(service.core().read(args.after,scope(args))); bridge?.acted(); break;
        case '/nudge': result={nudged:service.core().nudge()}; bridge?.acted(); break;
        case '/ack': { const cursor=args.cursor==='read'?lastDelivered:args.cursor;
          await service.core().ack(cursor,scope(args));
          presence.returned(); bridge?.acted();
          result={acked:cursor,...(args.session===undefined?{}:{session:args.session}),...(args.room===undefined?{}:{room:args.room})}; break; }
        case '/wait': {
          presence.returned();
          const canceled=new AbortController();
          const closed=()=>canceled.abort();
          res.once('close',closed);
          try {
            // --for message: an invitation or acceptance alone does not end the wait.
            const deadline=Date.now()+(args.timeout??30)*1000;
            let after=args.after;
            for(;;) {
              const page=await service.core().wait(after,Math.max(1,deadline-Date.now()),canceled.signal);
              if(page.nudged) { result=delivered({...service.core().read(args.after),nudged:true as const}); break; }
              if(args.for!=='message' || page.events.some(e=>e.kind==='message'||e.kind==='conference_message')) { result=delivered(args.for==='message'?service.core().read(args.after):page); break; }
              after=page.cursor;
            }
            bridge?.acted();
          }
          finally { res.off('close',closed); }
          break;
        }
        default: reply(404,{error:'unknown operation'}); return;
      }
      reply(200,result);
    } catch(e) { reply(400,{error:e instanceof Error?e.message:'request failed'}); }
  });
  server.requestTimeout=10000;
  server.listen(Number(values.port),'127.0.0.1',async()=>{
    const address=server.address();
    if(!address || typeof address==='string') throw new Error('missing API address');
    atomic(endpointFile,{url:'http://127.0.0.1:'+address.port,token});
    console.log(JSON.stringify({event:'ready',...info,apiPort:address.port,dir}));
    if(adapter || (semantic && backboneGiven)) {
      const routerTokenFile=join(dir,'router-token');
      if(!existsSync(routerTokenFile)) writeFileSync(routerTokenFile,randomBytes(32).toString('hex'),{mode:0o600});
      bridge=connectBackbone({
        path:resolve(values.backbone!),owner:values.name!,token:readFileSync(routerTokenFile,'utf8'),
        quietMs:ownerQuietMs,core:service.core(),present:()=>!foregroundDelivery&&presence.info(0,headSession()).present,rings:adapter!==undefined,onError:message=>console.error(message),
        onRing:({ring,name,unread})=>{
          if(!adapter) { refusedRings++; bridge!.refused(ring); return; }
          // VORTEX_ROOM: the room this ring was charged to. The adapter works on
          // that room only and acks with --room, so another room's budget never
          // pays for this room's mail and no other room's mail is acknowledged.
          const child=spawn(adapter,[],{cwd:process.cwd(),env:{...process.env,VORTEX_DIR:dir,VORTEX_UNREAD:String(unread),VORTEX_ROOM:name},stdio:'inherit'});
          ringProcess=child;bridge!.started(ring);
          const finish=(code:number)=>{
            if(ringProcess!==child) return;
            ringProcess=undefined;lastExitCode=code;bridge!.exited(ring,code);
            console.error(JSON.stringify({event:'ring-exit',code}));
          };
          child.once('error',e=>{console.error('ring adapter failed',e.message);finish(1);});
          child.once('exit',code=>finish(code??1));
        }
      });
      bridgeRef.current = bridge;
    }
    if(values.bootstrap) {
      stopBootstrap=connectBootstrap(transport,values.bootstrap,message=>console.error(message));
    }
  });
  const stop=async()=>{ offPresence();for(const close of [...attachments]) close();stopBootstrap?.(); bridge?.stop(); ringProcess?.kill('SIGTERM'); server.close(); if(wsBridge) await wsBridge.stop(); await service.stop(); process.exit(0); };
  process.once('SIGINT',()=>{void stop();}); process.once('SIGTERM',()=>{void stop();});
} else {
  if(!['attach','info','announce','discover','dial','invite','inbox','accept','send','read','ack','wait','nudge',
    'interests','withdraw','matches','create','join','post','history','leave','conferences',
    'subscribe','subscriptions','unsubscribe','revise'].includes(operation??'')) {
    console.error('bun src/cli.ts <serve|attach|info|announce|discover|dial|invite|inbox|accept|send|read|ack|wait|nudge|interests|withdraw|matches|create|join|post|history|leave|conferences|subscribe|subscriptions|unsubscribe|revise> --dir .vortex/<owner> [--peer id|multiaddr] [--room id] [--text text] [--statement text] [--session id] [--ttl seconds] [--publish-statement] [--replaces id] [--id id] [--capacity N] [--admission open|invitation|group] [--admission-peer id] [--ref id] [--conference id] [--type type] [--reply-to id] [--after cursor] [--limit N] [--cursor N] [--timeout seconds] [--on-ring executable] [--semantic] [--history-limit N] [--dedup-limit N] [--conference-history-limit N] [--conference-history-bytes N] [--subscription-limit N] [--subscription-max-ttl seconds] [--disclosure-policy FILE] [--outcomes JSON] [--peer-memory-ttl seconds] [--peer-memory-limit N] [--peer-memory-bytes N]');
    process.exit(1);
  }
  let feedback: ConferenceFeedback | undefined;
  try {
    if (values.outcomes !== undefined && operation !== 'leave' && operation !== 'unsubscribe')
      throw Error('feedback requires conference or subscription leave');
    if (operation === 'withdraw' && values.statement !== undefined)
      throw Error('feedback requires conference or subscription leave');
    if (operation === 'leave' || operation === 'unsubscribe')
      feedback = feedbackArgs({outcomes:values.outcomes === undefined ? undefined : JSON.parse(values.outcomes),statement:values.statement});
  } catch {
    failJson({error:'invalid private feedback arguments',got:'',example:'bun src/cli.ts leave --conference <id> --dir .vortex/local'});
  }
  const argError = validateArgs(operation!, values);
  if (argError) failJson(argError);
  let hostPid:number|undefined;
  if(operation==='attach') {
    const raw=values['host-pid'];
    try {
      hostPid=raw==='self-host'?selfHostPid():raw===undefined?undefined:Number(raw);
      if(hostPid!==undefined&&(!Number.isSafeInteger(hostPid)||hostPid<0||raw!==undefined&&raw!=='self-host'&&!/^\d+$/.test(raw)))
        throw Error('--host-pid must be a non-negative integer or self-host');
    } catch(error) {
      failJson({error:error instanceof Error?error.message:'invalid --host-pid',got:raw??'',example:'bun src/cli.ts attach --host-pid self-host'});
    }
  }
  const endpoint=JSON.parse(readFileSync(endpointFile,'utf8'));
  if(operation==='attach') {
    await new Promise<void>((resolve,reject)=>{
      const request=httpRequest(endpoint.url+'/attach',{method:'POST',headers:{authorization:'Bearer '+endpoint.token,'content-type':'application/json'}},response=>{
        if(response.statusCode!==200) process.exitCode=1;
        response.pipe(process.stdout);
        response.on('end',resolve);response.on('error',reject);
      });
      request.setTimeout(0);request.on('error',reject);
      request.end(JSON.stringify({next:values.next,hostPid,session:values.session}));
    });
  } else {
  const response=await fetch(endpoint.url+'/'+operation,{method:'POST',headers:{authorization:'Bearer '+endpoint.token,'content-type':'application/json'},
    body:JSON.stringify({limit:values.limit===undefined?undefined:Number(values.limit),for:values.for,peer:values.peer,room:values.room,text:values.text,after:values.after===undefined?undefined:Number(values.after),cursor:values.cursor===undefined?undefined:values.cursor==='read'?'read':Number(values.cursor),timeout:Number(values.timeout),
      outcomes:feedback?.outcomes,statement:values.statement,session:values.session,ttl:values.ttl===undefined?undefined:Number(values.ttl),
      capacity:values.capacity===undefined?undefined:Number(values.capacity),admission:values.admission,peers:values['admission-peer'],
      publishStatement:values['publish-statement'],replaces:values.replaces,id:values.id,ref:values.ref,conference:values.conference,type:values.type,replyTo:values['reply-to']}),
    signal:AbortSignal.timeout(operation==='wait'?65000:operation==='join'?30000:operation==='history'?65000:feedback?.statement!==undefined?300000:(operation==='create'||operation==='revise'||(operation==='announce'&&values.statement!==undefined))?300000:10000)});
  console.log(JSON.stringify(await response.json(),null,2));
  if(!response.ok) process.exitCode=1;
  }
}
