import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Presence, readProcess, selfHostPid } from './presence.ts'

test('open lines fan out metadata, detach independently and retain a live host', () => {
  const dir=mkdtempSync(join(tmpdir(),'vortex-presence-'))
  const processes=new Map([[123,{pid:123,ppid:1,name:'claude',startTime:'100'}]])
  const lookup=(pid:number)=>processes.get(pid)
  try {
    const p=new Presence(dir,()=>{},lookup)
    const a:any[]=[],b:any[]=[]
    const offA=p.attach(x=>a.push(x),123),offB=p.attach(x=>b.push(x))
    assert.equal(p.info(0).lines,2)
    p.notify({cursor:7,unread:2})
    assert.deepEqual(a,[{cursor:7,unread:2}]);assert.deepEqual(b,a)
    offA();offA();assert.equal(p.info(0).lines,1)
    offB();assert.equal(p.info(0).present,true)
    assert.deepEqual(p.info(1),{lines:1,hosts:[{pid:123,alive:true}],present:true})
    const restored=new Presence(dir,()=>{},lookup)
    assert.equal(restored.info(0).present,true)
    processes.set(123,{pid:123,ppid:1,name:'claude',startTime:'101'})
    assert.equal(restored.info(0).present,false,'reused pid is not the old host')
    assert.deepEqual(JSON.parse(readFileSync(join(dir,'presence.json'),'utf8')),[])
    p.attach(()=>{},0)()
    assert.equal(p.info(0).present,false,'explicit withdrawal clears registrations')
  } finally {rmSync(dir,{recursive:true,force:true})}
})

test('invalid host registrations are rejected and waiters remain lines', () => {
  const dir=mkdtempSync(join(tmpdir(),'vortex-presence-'))
  try {
    const p=new Presence(dir,()=>{},()=>undefined)
    for(const pid of [-1,1.5,NaN,123]) assert.throws(()=>p.attach(()=>{},pid))
    assert.deepEqual(p.info(2),{lines:2,hosts:[],present:true})
    assert.equal(p.info(0).present,false)
    assert.equal(readProcess(process.pid)?.pid,process.pid)
    const tree=new Map([[4,{pid:4,ppid:3,name:'sh',startTime:'4'}],[3,{pid:3,ppid:2,name:'codex',startTime:'3'}],[2,{pid:2,ppid:1,name:'claude',startTime:'2'}]])
    assert.equal(selfHostPid(4,pid=>tree.get(pid)),3)
    assert.throws(()=>selfHostPid(1,()=>undefined),/host/)
    const native=new Map([[9,{pid:9,ppid:8,name:'bash',startTime:'9'}],[8,{pid:8,ppid:1,name:'2.1.308',startTime:'8',exe:'/opt/claude/versions/2.1.308'}]])
    assert.equal(selfHostPid(9,pid=>native.get(pid)),8,'native Claude Code is named by its version; match its executable')
    assert.ok(readProcess(process.pid)?.exe,'readProcess reports the executable')
  } finally {rmSync(dir,{recursive:true,force:true})}
})

// skills/vortex/SKILL.md: a live session scoped to its session handles only its own conferences.
test('a session-scoped line or host is present and notified only for its own head topic', () => {
  const dir=mkdtempSync(join(tmpdir(),'vortex-presence-'))
  const processes=new Map([[123,{pid:123,ppid:1,name:'claude',startTime:'100'}]])
  try {
    const p=new Presence(dir,()=>{},pid=>processes.get(pid))
    const scoped:any[]=[]
    const off=p.attach(x=>scoped.push(x),123,'live')
    assert.equal(p.info(0).present,false,'no head topic: nothing claimed')
    assert.equal(p.info(0,'other').present,false,'another session\'s topic rings the adapter')
    assert.equal(p.info(0,'live').present,true)
    p.notify({cursor:3,unread:1},[{cursor:3,owner:'other'}]);p.notify({cursor:4,unread:2},[{cursor:3,owner:'other'},{cursor:4}])
    assert.deepEqual(scoped,[])
    // Head-of-line: an owned event behind foreign ones still wakes the line.
    const queue=[{cursor:3,owner:'other'},{cursor:4},{cursor:5,owner:'live'}]
    p.notify({cursor:5,unread:3},queue)
    assert.deepEqual(scoped,[{cursor:5,unread:1}])
    p.notify(undefined,queue)
    assert.deepEqual(scoped,[{cursor:5,unread:1}],'no repeat for an owned event already announced')
    p.notify(undefined,[...queue,{cursor:6,owner:'live'}])
    assert.deepEqual(scoped.at(-1),{cursor:6,unread:2})
    off()
    assert.equal(p.info(0,'live').present,true,'the registered host keeps its scope after the line drops')
    assert.equal(p.info(0).present,false)
    assert.equal(new Presence(dir,()=>{},pid=>processes.get(pid)).info(0,'live').present,true,'scope survives restart')
    const plain:any[]=[]
    p.attach(x=>plain.push(x))
    assert.equal(p.info(0).present,true,'an unscoped line still claims every topic')
    p.notify({cursor:7,unread:1},[{cursor:7,owner:'other'}]);assert.deepEqual(plain,[{cursor:7,unread:1}])
    p.notify(undefined,[{cursor:7,owner:'other'}]);assert.equal(plain.length,1,'unscoped lines hear only new cursors')
    for(const session of ['',7,'x'.repeat(129)]) assert.throws(()=>p.attach(()=>{},undefined,session as never),/session/)
  } finally {rmSync(dir,{recursive:true,force:true})}
})
