// Docs: VORTEX_v5.1.md §10.2. Only startup configuration can choose an approval executable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDisclosurePolicy } from './disclosure-config.ts';

test('owner-selected approval receives JSON once per announcement and denial stays private',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'vortex-disclosure-'));
  const path=join(dir,'policy.json');
  try {
    writeFileSync(join(dir,'approve.sh'),'#!/bin/sh\ncat >> approved.jsonl\n',{mode:0o700});
    writeFileSync(path,JSON.stringify({requireApproval:true,approvalCommand:'./approve.sh'}));
    const check=loadDisclosurePolicy(path);
    const request={kind:'announcement' as const,namespace:'n',network:'loopback',text:'public problem'};
    await check(request); await check(request);
    assert.deepEqual(readFileSync(join(dir,'approved.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s)),[request,request]);
    writeFileSync(join(dir,'approve.sh'),'#!/bin/sh\nprintf "private diagnostic" >&2\nexit 1\n',{mode:0o700});
    await assert.rejects(check(request),error=>error instanceof Error && !error.message.includes('private diagnostic'));
    writeFileSync(path,'{"secret=private"');
    assert.throws(()=>loadDisclosurePolicy(path),error=>error instanceof Error && error.message.includes('invalid disclosure') && !error.message.includes('secret'));
    writeFileSync(path,JSON.stringify({requireApproval:true,approvalCommand:'./missing'}));
    assert.throws(()=>loadDisclosurePolicy(path),/invalid disclosure/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
