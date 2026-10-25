// Docs: TODO.md I2; README.md — Bootstrap the three owner services.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const owners=['codex','claude','opencode'] as const;
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

test('owner unit commands rediscover all three services after a restart without manual dialing', {timeout:90000}, async()=>{
  const root=mkdtempSync(join(tmpdir(),'vortex-unit-bootstrap-'));
  const processes:ChildProcess[]=[];
  const ids:Record<string,string>={};
  const ports:Record<string,number>={};
  const commands=Object.fromEntries(owners.map(owner=>{
    const unit=readFileSync(join(checkout,'deploy/systemd',`vortex-${owner}.service`),'utf8');
    const command=unit.split('\n').find(line=>line.startsWith('ExecStart='))!.slice('ExecStart='.length);
    return [owner,command];
  }));
  const stop=async(child:ChildProcess)=>{
    if(child.exitCode!==null || child.signalCode!==null) return;
    await new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.kill('SIGTERM');});
  };
  const start=async(owner:typeof owners[number],provision=false)=>{
    // Execute the shipped command with isolated state, executable and ports; no installed units or wake router.
    let command=commands[owner].replace('/home/user/.bun/bin/bun',process.execPath).replaceAll('<checkout>',root);
    for(const name of owners) {
      command=command.replaceAll(`<${name}-peer-id>`,ids[name]??'provisioning');
      if(ports[name]) command=command.replaceAll(`/tcp/${7810+owners.indexOf(name)}/`,`/tcp/${ports[name]}/`);
    }
    const args=command.split(' ');
    args[args.indexOf('--port')+1]='0';
    args[args.indexOf('--p2p-port')+1]=String(ports[owner]??0);
    if(provision && args.includes('--bootstrap')) args.splice(args.indexOf('--bootstrap'),2);
    const dir=join(root,'.vortex',owner), endpointPath=join(dir,'endpoint.json');
    if(existsSync(endpointPath)) unlinkSync(endpointPath);
    const child=spawn(args[0],args.slice(1),{cwd:checkout,stdio:['ignore','ignore','pipe']});
    processes.push(child);
    let errors=''; child.stderr?.on('data',chunk=>{errors+=chunk.toString();});
    const until=Date.now()+10000;
    while(!existsSync(endpointPath)) {
      if(child.exitCode!==null || Date.now()>until) throw Error(`unit ${owner} did not start: ${errors}`);
      await sleep(20);
    }
    const endpoint=JSON.parse(readFileSync(endpointPath,'utf8'));
    const call=async(op:string,args:unknown={})=>{
      const response=await fetch(endpoint.url+'/'+op,{method:'POST',headers:{authorization:'Bearer '+endpoint.token},body:JSON.stringify(args)});
      const value=await response.json() as any;
      if(!response.ok) throw Error(value.error);
      return value;
    };
    return {child,call};
  };
  try {
    // Provision identities once, as an owner does at installation. No live agent state is read.
    for(const owner of owners) {
      const service=await start(owner,true);
      const info=await service.call('info');
      ids[owner]=info.peerId; ports[owner]=Number(info.addrs[0].split('/')[4]);
      await stop(service.child);
    }
    const services=Object.fromEntries(await Promise.all(owners.map(async owner=>[owner,await start(owner)])));
    const discovered=async()=>{
      const deadline=Date.now()+20000;
      while(true) {
        const peers=await Promise.all(owners.map(async owner=>(await services[owner].call('discover')).peers.map((p:any)=>p.id)));
        if(peers.every((list,i)=>owners.filter((_,j)=>j!==i).every(name=>list.includes(ids[name])))) return;
        if(Date.now()>deadline) throw Error('owner services did not discover one another from unit bootstrap commands');
        await sleep(100);
      }
    };
    await discovered();
    // Stop all three, clear their in-memory directories, and restart in reverse order using the same configuration.
    for(const owner of owners) await stop(services[owner].child);
    for(const owner of [...owners].reverse()) services[owner]=await start(owner);
    await discovered();
    for(const owner of owners) assert.equal((await services[owner].call('info')).peerId,ids[owner]);
  } finally {
    await Promise.all(processes.map(stop));
    rmSync(root,{recursive:true,force:true});
  }
});
