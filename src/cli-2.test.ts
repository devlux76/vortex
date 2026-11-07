import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { createMcpHandler, protocolVersion } from './mcp-protocol.ts';

import {  } from './cli.testkit.ts'

// Docs: VORTEX_v5.1.md sections 6.1 and 11.5
test('revise CLI and API route to the service without loading the model', {timeout:90000}, async () => {
  const root=mkdtempSync(join(tmpdir(),'vortex-cli-revise-'));
  const processes:ChildProcess[]=[];
  const forbid={VORTEX_TEST_FORBID_MODEL_LOAD:'1'};
  const run=(args:string[],dir:string) => {
    const r=spawnSync('bun',['src/cli.ts',...args,'--dir',dir],{encoding:'utf8',timeout:30000});
    return {exit:r.status,json:JSON.parse(r.stdout.trim()||'null') as any,raw:r.stdout+r.stderr};
  };
  const start=async (name:string,extra:string[]) => {
    const dir=join(root,name);
    mkdirSync(dir,{recursive:true});
    if(existsSync(join(dir,'endpoint.json'))) unlinkSync(join(dir,'endpoint.json'));
    const child=spawn('bun',['src/cli.ts','serve','--dir',dir,'--name',name,'--port','0',...extra],
      {stdio:'ignore',env:{...process.env,...forbid}});
    processes.push(child);
    const end=Date.now()+8000;
    while(!existsSync(join(dir,'endpoint.json'))) {
      if(child.exitCode!==null || Date.now()>end) throw new Error('test service did not start');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    return {dir,child};
  };
  try {
    const sem=await start('sem',['--semantic']);
    const id='b'.repeat(32);
    const unknown=run(['revise','--conference',id,'--statement','new topic'],sem.dir);
    assert.notEqual(unknown.exit,0);
    assert.match(unknown.json.error,/not hosting this conference/);
    const endpoint=JSON.parse(readFileSync(join(sem.dir,'endpoint.json'),'utf8'));
    const empty=await fetch(endpoint.url+'/revise',{method:'POST',headers:{authorization:'Bearer '+endpoint.token,
      'content-type':'application/json'},body:JSON.stringify({conference:id,statement:''})});
    assert.equal(empty.status,400);
    assert.match((await empty.json() as any).error,/statement/);
    const plain=await start('plain',[]);
    const denied=run(['revise','--conference',id,'--statement','new topic'],plain.dir);
    assert.notEqual(denied.exit,0);
    assert.match(denied.json.error,/not enabled/);
  } finally {
    await Promise.all(processes.filter(p=>p.exitCode===null&&p.signalCode===null).map(p=>new Promise<void>(resolve=>{p.once('exit',()=>resolve());p.kill('SIGTERM');})));
    rmSync(root,{recursive:true,force:true});
  }
});

test('private feedback CLI validates without echoing source and retention flags fail before state creation',{timeout:60000},()=>{
  const root=mkdtempSync(join(tmpdir(),'vortex-feedback-validation-'));
  try {
    const entry={participant:'b'.repeat(64),outcome:'useful'}, id='a'.repeat(32), secret='private-source-marker';
    const cases=[
      ['leave','--conference',id,'--outcomes',secret],
      ['leave','--conference',id,'--outcomes='+secret,'--unknown'],
      ['leave','--conference',id,'--statement='+secret,'--unknown'],
      ['leave','--conference',id,'--outcomes','[]'],
      ['leave','--conference',id,'--outcomes',JSON.stringify([entry,entry])],
      ['unsubscribe','--conference',id,'--outcomes',JSON.stringify([{...entry,service:secret}])],
      ['leave','--conference',id,'--statement',secret],
      ['withdraw','--id',id,'--outcomes',JSON.stringify([entry]),'--statement',secret],
      ...[['peer-memory-ttl','0'],['peer-memory-ttl','31536001'],['peer-memory-limit','0'],
        ['peer-memory-limit','4097'],['peer-memory-bytes','0'],['peer-memory-bytes','67108865'],
        ['peer-memory-limit','1.5']].map(([flag,value])=>['serve','--'+flag,value])
    ];
    for(const args of cases) {
      const dir=join(root,'absent');
      const r=spawnSync('bun',['src/cli.ts',...args,'--dir',dir],{encoding:'utf8',timeout:10000});
      assert.notEqual(r.status,0);
      const json=JSON.parse(r.stdout.trim());
      assert.equal(typeof json.error,'string');
      assert.ok(!(r.stdout+r.stderr).includes(secret),'private input must not enter diagnostics');
      assert.equal(existsSync(dir),false);
    }
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('private feedback CLI forwards parsed outcomes through the owner endpoint',async()=>{
  const {createServer}=await import('node:http');
  const root=mkdtempSync(join(tmpdir(),'vortex-feedback-forward-'));
  const received:any[]=[];
  const server=createServer(async(req,res)=>{
    let body=''; for await(const chunk of req) body+=chunk;
    received.push({path:req.url,body:JSON.parse(body)});
    res.setHeader('content-type','application/json');res.end(JSON.stringify({left:true}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const port=(server.address() as {port:number}).port;
    writeFileSync(join(root,'endpoint.json'),JSON.stringify({url:`http://127.0.0.1:${port}`,token:'test'}));
    const outcomes=[{participant:'b'.repeat(64),outcome:'misleading'}];
    for(const op of ['leave','unsubscribe']) {
      const child=spawn('bun',['src/cli.ts',op,'--dir',root,'--session','s','--conference','a'.repeat(32),
        '--outcomes',JSON.stringify(outcomes),'--statement','private source'],{stdio:'pipe'});
      let raw='';child.stdout!.on('data',chunk=>raw+=chunk);child.stderr!.on('data',chunk=>raw+=chunk);
      const code=await new Promise(resolve=>child.once('exit',resolve));
      assert.equal(code,0,raw);
      assert.equal(received.at(-1).path,'/'+op);
      assert.deepEqual(received.at(-1).body.outcomes,outcomes);
      assert.equal(received.at(-1).body.statement,'private source');
    }
  } finally {server.close();rmSync(root,{recursive:true,force:true});}
});

test('private feedback API validates before membership and exposes only retention settings and counts',async()=>{
  const root=mkdtempSync(join(tmpdir(),'vortex-feedback-api-'));
  const peer=peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
  const privateRecord={peer,participant:'b'.repeat(64),namespace:'c'.repeat(64),profileVersion:1,
    statement:'retained-private-source',vector:'0000803f',outcome:'useful',recordedAt:Date.now()-1000,expires:Date.now()+60000};
  writeFileSync(join(root,'state.json'),JSON.stringify({rooms:{},events:[],seen:[],cursor:0,peerMemory:[privateRecord]}));
  const child=spawn('bun',['src/cli.ts','serve','--dir',root,'--port','0','--semantic',
    '--peer-memory-ttl','60','--peer-memory-limit','8','--peer-memory-bytes','4096'],
    {stdio:'pipe',env:{...process.env,VORTEX_TEST_FORBID_MODEL_LOAD:'1'}});
  let raw='';child.stderr!.on('data',chunk=>raw+=chunk);
  try {
    const end=Date.now()+8000;
    while(!existsSync(join(root,'endpoint.json'))) {
      if(child.exitCode!==null || Date.now()>end) throw Error('service failed: '+raw);
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const endpoint=JSON.parse(readFileSync(join(root,'endpoint.json'),'utf8'));
    const call=async(op:string,args:unknown={})=>{
      const response=await fetch(endpoint.url+'/'+op,{method:'POST',headers:{authorization:'Bearer '+endpoint.token},body:JSON.stringify(args)});
      return {status:response.status,body:await response.json() as any};
    };
    const info=(await call('info')).body;
    assert.deepEqual(Object.keys(info.peerMemory).sort(),['bytes','count','maxBytes','maxCount','ttl']);
    assert.deepEqual({...info.peerMemory,bytes:0},{ttl:60,maxCount:8,maxBytes:4096,count:1,bytes:0});
    assert.ok(info.peerMemory.bytes>0);
    const handler=createMcpHandler(async(op,args)=>(await call(op,args)).body);
    const status=await handler({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'vortex_status',arguments:{},
      _meta:{'io.modelcontextprotocol/protocolVersion':protocolVersion,'io.modelcontextprotocol/clientCapabilities':{}}}}) as any;
    assert.equal(status.result.isError,false);
    assert.equal(status.result.structuredContent.trust,'untrusted_peer_content');
    assert.deepEqual(status.result.structuredContent.data.info.peerMemory,info.peerMemory);
    for(const secret of [privateRecord.statement,privateRecord.vector,privateRecord.participant,privateRecord.namespace])
      assert.ok(!JSON.stringify({info,status}).includes(secret));
    const entry={participant:'b'.repeat(64),outcome:'useful'}, base={session:'s',conference:'a'.repeat(32)};
    for(const op of ['leave','unsubscribe']) {
      for(const extra of [{statement:'private-marker'},{outcomes:[]},{outcomes:[{...entry,vector:'private-marker'}]}]) {
        const response=await call(op,{...base,...extra});
        assert.equal(response.status,400);
        assert.match(response.body.error,/feedback/);
        assert.ok(!JSON.stringify(response).includes('private-marker'));
      }
    }
    const denied=await call('leave',{...base,outcomes:[entry]});
    assert.equal(denied.status,400);assert.match(denied.body.error,/member/);
    const withdrawn=await call('withdraw',{session:'s',id:'a'.repeat(32),outcomes:[entry]});
    assert.equal(withdrawn.status,400);
    assert.match(withdrawn.body.error,/feedback/);
    assert.deepEqual((await call('leave',base)).body,{left:false});
    assert.deepEqual((await call('unsubscribe',base)).body,{unsubscribed:false});
    assert.deepEqual(JSON.parse(readFileSync(join(root,'state.json'),'utf8')).peerMemory,[privateRecord]);
  } finally {
    if(child.exitCode===null&&child.signalCode===null) await new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.kill('SIGTERM');});
    rmSync(root,{recursive:true,force:true});
  }
});
