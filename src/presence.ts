import { existsSync, readFileSync, readlinkSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export interface ProcessIdentity { pid:number; ppid:number; name:string; startTime:string; exe?:string }
export type ProcessLookup=(pid:number)=>ProcessIdentity|undefined
export interface Notice { cursor:number; unread:number }
/** A host scoped to a session claims only topics that session owns; unscoped hosts claim all. */
interface Host { pid:number; startTime:string; session?:string }

/** /proc start time distinguishes a live host from a reused numeric pid. */
export function readProcess(pid:number):ProcessIdentity|undefined {
  if(!Number.isSafeInteger(pid)||pid<1) return undefined
  try {
    const stat=readFileSync(`/proc/${pid}/stat`,'utf8'),end=stat.lastIndexOf(')')
    const fields=stat.slice(end+2).trim().split(/\s+/)
    if(end<0||fields.length<20||fields[0]==='Z'||fields[0]==='X'||!/^\d+$/.test(fields[19])) return undefined
    let exe:string|undefined
    try {exe=readlinkSync(`/proc/${pid}/exe`)} catch {exe=undefined}
    return {pid,ppid:Number(fields[1]),name:stat.slice(stat.indexOf('(')+1,end),startTime:fields[19],...(exe?{exe}:{})}
  } catch {return undefined}
}

export function selfHostPid(start=process.ppid,lookup:ProcessLookup=readProcess):number {
  const seen=new Set<number>()
  for(let pid=start;pid>0&&!seen.has(pid);) {
    seen.add(pid)
    const info=lookup(pid)
    if(!info) break
    // Claude Code's native build runs as ~/.local/share/claude/versions/<version>,
    // so its process name is the version string; match its executable instead.
    if(['claude','codex','opencode','beam.smp'].includes(info.name)||/\/claude\/versions\/[^/]+$/.test(info.exe??'')) return pid
    pid=info.ppid
  }
  throw Error('no recognized ancestor host process')
}

/** Node-side presence; no lease, liveness polling, credentials or peer bodies. */
export class Presence {
  private hosts:Host[]=[]
  private lines=new Map<(notice:Notice)=>void,string|undefined>()
  /** The newest owned cursor each scoped line was told about. */
  private told=new WeakMap<(notice:Notice)=>void,number>()
  private readonly file:string
  private dir:string
  private changed:()=>void
  private lookup:ProcessLookup
  constructor(dir:string,changed:()=>void,lookup:ProcessLookup=readProcess) {
    this.dir=dir;this.changed=changed;this.lookup=lookup
    this.file=join(dir,'presence.json')
    if(existsSync(this.file)) {
      const rows:unknown=JSON.parse(readFileSync(this.file,'utf8'))
      if(!Array.isArray(rows)||!rows.every(h=>h&&Number.isSafeInteger(h.pid)&&h.pid>0&&typeof h.startTime==='string'&&/^\d+$/.test(h.startTime)&&(h.session===undefined||validSession(h.session)))) throw Error('invalid persisted presence registry')
      this.hosts=rows
    }
  }
  private save(hosts=this.hosts) {
    writeFileSync(this.file+'.tmp',JSON.stringify(hosts),{mode:0o600})
    renameSync(this.file+'.tmp',this.file)
    this.hosts=hosts
  }
  /** This epoch resets away throttling after actual owner presence, not a clock lease. */
  returned() {writeFileSync(join(this.dir,'presence-epoch'),randomBytes(16).toString('hex'),{mode:0o600})}
  /**
   * Open a line. With a session, the line (and its registered host) claims
   * only topics that session owns: it is present when the head event is its
   * own, and it is woken for each of its own unread events wherever they sit;
   * other topics ring the adapter. Without one, it claims every topic.
   * `toldThrough` is the newest owned cursor the caller already reported.
   */
  attach(line:(notice:Notice)=>void,hostPid?:number,session?:string,toldThrough=0):()=>void {
    if(session!==undefined&&!validSession(session)) throw Error('session must contain 1 to 128 characters')
    if(hostPid!==undefined) {
      if(!Number.isSafeInteger(hostPid)||hostPid<0) throw Error('hostPid must be a non-negative integer')
      if(hostPid===0) this.save([])
      else {
        const host=this.lookup(hostPid)
        if(!host) throw Error('host process is not alive')
        this.save([...this.hosts.filter(h=>h.pid!==hostPid),{pid:hostPid,startTime:host.startTime,...(session===undefined?{}:{session})}])
      }
    }
    this.returned()
    this.lines.set(line,session);this.told.set(line,toldThrough);this.changed()
    return ()=>{if(this.lines.delete(line)) this.changed()}
  }
  /** `head` is the session owning the oldest unread event's topic, if any. */
  info(waiters:number,head?:string) {
    const alive=this.hosts.filter(h=>this.lookup(h.pid)?.startTime===h.startTime)
    if(alive.length!==this.hosts.length) {this.save(alive);this.changed()}
    const lines=this.lines.size+waiters
    const claims=(session:string|undefined)=>session===undefined||session===head
    const present=waiters>0||[...this.lines.values()].some(claims)||alive.some(h=>claims(h.session))
    return {lines,hosts:alive.map(h=>({pid:h.pid,alive:true,...(h.session===undefined?{}:{session:h.session})})),present}
  }
  /**
   * `notice` (a new durable cursor, if any) goes to unscoped lines. A scoped
   * line hears whenever its session has an unread event it was not yet told
   * about, wherever that event sits behind other topics (no head-of-line
   * blocking); `unread` lists every unread event with its owning session.
   */
  notify(notice:Notice|undefined,unread:{cursor:number;owner?:string}[]=[]) {
    for(const [line,session] of [...this.lines]) {
      if(session===undefined) {if(notice) line(notice);continue}
      const mine=unread.filter(u=>u.owner===session),top=mine.at(-1)?.cursor
      if(top===undefined||top<=(this.told.get(line)??0)) continue
      this.told.set(line,top);line({cursor:top,unread:mine.length})
    }
  }
}

function validSession(session:unknown):session is string {
  return typeof session==='string'&&session.length>=1&&session.length<=128
}
