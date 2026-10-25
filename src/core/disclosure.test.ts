// Docs: VORTEX_v5.1.md §§10.2, 8.2; TODO.md A2.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDisclosurePolicy } from './disclosure.ts';

const announcement={kind:'announcement' as const,namespace:'n',network:'loopback',text:'a public problem'};
test('configured scope and patterns refuse sensitive content without echoing it',async()=>{
  const policy=createDisclosurePolicy({allowedNamespaces:['n'],allowedNetworks:['loopback'],
    blockedPatterns:{credentials:['secret=[^ ]+'],paths:['/private/'],hostnames:['internal\\.example']},blockedProjectIds:['PrivateProject']});
  await policy(announcement);
  for(const request of [
    {...announcement,namespace:'other'}, {...announcement,network:'remote'},
    {...announcement,text:'secret=hunter2'}, {...announcement,text:'/private/work'},
    {...announcement,text:'internal.example'}, {...announcement,text:'PRIVATEPROJECT implementation'},
    {...announcement,kind:'message' as const,text:'secret=hunter2'}
  ]) await assert.rejects(policy(request),error=>error instanceof Error && error.message.startsWith('disclosure policy refused:') && !error.message.includes(request.text));
  await assert.rejects(createDisclosurePolicy({allowedNamespaces:[]})(announcement),/namespace/);
  await assert.rejects(createDisclosurePolicy({allowedNetworks:[]})(announcement),/network/);
});

test('approval is per announcement, follows rejection checks and fails closed',async()=>{
  let calls=0;
  const policy=createDisclosurePolicy({requireApproval:true,blockedProjectIds:['blocked']},async request=>{calls++;assert.equal(request.text,announcement.text);});
  await policy(announcement); await policy(announcement);
  assert.equal(calls,2);
  await policy({...announcement,kind:'message'});
  assert.equal(calls,2);
  await assert.rejects(policy({...announcement,text:'blocked'}),/project/);
  assert.equal(calls,2);
  await assert.rejects(createDisclosurePolicy({requireApproval:true})(announcement),/approval/);
  await assert.rejects(createDisclosurePolicy({requireApproval:true},async()=>{throw Error('secret in callback');})(announcement),error=>error instanceof Error && !error.message.includes('secret'));
});

test('invalid configuration is rejected at creation and caller mutation cannot weaken it',async()=>{
  for(const config of [null,[],{unknown:true},{requireApproval:'true'},{allowedNetworks:['']},{blockedPatterns:{credentials:['[']}},{blockedPatterns:{unknown:['x']}},{blockedProjectIds:[1]}])
    assert.throws(()=>createDisclosurePolicy(config),/invalid disclosure policy/);
  const config={blockedProjectIds:['blocked'],allowedNamespaces:['n']};
  const policy=createDisclosurePolicy(config);
  config.blockedProjectIds.length=0; config.allowedNamespaces.push('other');
  await assert.rejects(policy({...announcement,text:'blocked'}),/project/);
  await assert.rejects(policy({...announcement,namespace:'other'}),/namespace/);
  await createDisclosurePolicy({})(announcement);
});
