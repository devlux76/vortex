// Docs: VORTEX_v5.1.md §§6.3, 7.3, 9.3, 10.5; ISSUES.md I1–I3 (consent, deduplication, durable delivery).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Conversations } from './conversations.ts';
import type { Snapshot, Packet } from './conversations.ts';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { makeProfile } from '../embed/profile.ts';
import { encodeVector } from '../embed/vector.ts';
import type { PeerMemoryRecord } from './peer-memory.ts';


export function pair() {
  let savedA: Snapshot | undefined;
  let savedB: Snapshot | undefined;
  const pending: { from: string; to: string; packet: Packet }[] = [];
  const a = new Conversations('a', { send: async (to,packet) => { pending.push({from:'a',to,packet}); }, save: s => { savedA=s; } });
  const b = new Conversations('b', { send: async (to,packet) => { pending.push({from:'b',to,packet}); }, save: s => { savedB=s; } });
  const drain = async () => { while(pending.length) { const p=pending.shift()!; await (p.to==='a'?a:b).receive(p.from,p.packet); } };
  return {a,b,drain,pending, saved: () => ({a:savedA,b:savedB})};
}

export const tick = () => new Promise<void>(r => setTimeout(r, 0));

/** A save returning a promise the test resolves by hand; tracks concurrency. */
export function deferredSave() {
  const calls: { resolve: () => void, reject: (e: unknown) => void }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const save = (_snapshot: Snapshot) => new Promise<void>((resolve, reject) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    calls.push({ resolve: () => { inFlight--; resolve(); }, reject: (e: unknown) => { inFlight--; reject(e); } });
  });
  return { save, calls, stats: () => ({ maxInFlight }) };
}

export function consentedB(save: (_snapshot: Snapshot) => void | Promise<void>) {
  const room = JSON.stringify(['a', 'b'].sort());
  const restored: Snapshot = { rooms: { [room]: { peer: 'a', localConsent: true, remoteConsent: true } }, events: [], seen: [], cursor: 0 };
  return { core: new Conversations('b', { send: async () => {}, save }, restored), room };
}

export const conferenceEvents = [
  {kind:'formed' as const},
  {kind:'arrival' as const,participant:'b'.repeat(64),service:'c',count:2},
  {kind:'departure' as const,participant:'b'.repeat(64),count:1},
  {kind:'conference_message' as const,participant:'b'.repeat(64),service:'c',message:'c'.repeat(32),type:'text',replyTo:'d'.repeat(32),body:'peer words'},
  {kind:'closed' as const,reason:'host_closed'}
];
// Docs: VORTEX_v5.1.md sections 6.2, 6.4, 9.3 and 10.5

// TODO.md C8 durable subscription store.
export const subConf = (i: number): string => i.toString(16).padStart(32, '0');
export const subInput = (conference: string, session = 's1', host = 'h1', expires = 9999999999999, membership?: { descriptor: string, privateKey: string }): { conference: string, session: string, host: string, expires: number, membership?: { descriptor: string, privateKey: string } } =>
  membership === undefined ? { conference, session, host, expires } : { conference, session, host, expires, membership };
export const subMsg = (conference: string, message: string, session = 's1', peer = 'h1'): { kind: 'conference_message', conference: string, session: string, peer: string, message: string, type: string, body: string } =>
  ({ kind: 'conference_message', conference, session, peer, message, type: 'text', body: 'body-' + message.slice(0, 8) });

// Docs: VORTEX_v5.1.md §5.5; TODO.md C9 — private durable peer-outcome memory.
export const memoryProfile = makeProfile({
  model: 'm', revision: 'r1', weights: 'q4', prompt: 'p: ', maxTokens: 64,
  truncation: 'tail', pooling: 'mean', normalization: 'l2',
  dims: [8, 4, 2], encoding: 'float32le', version: 3, tolerance: 0.001,
  thresholds: { 8: 0.9, 4: 0.9, 2: 0.9 }
});
export const memoryVector = Float32Array.from([0.5, -0.25, 0.125, 1, 0, 0, 0, 2]);
export const memoryVectorHex = Array.from(encodeVector(memoryVector), byte => byte.toString(16).padStart(2, '0')).join('');

export async function memoryPeer (): Promise<string> {
  return peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
}

export async function memoryRecord (overrides: Partial<PeerMemoryRecord> = {}): Promise<PeerMemoryRecord> {
  const at = Date.now();
  return {
    peer: await memoryPeer(),
    participant: 'ab'.repeat(32),
    namespace: memoryProfile.id,
    profileVersion: 3,
    statement: 'handled it well',
    vector: memoryVectorHex,
    outcome: 'useful',
    recordedAt: at - 1000,
    expires: at + 8000000,
    ...overrides
  };
}

export function memoryCore (save?: (s: Snapshot) => void | Promise<void>): Conversations {
  return new Conversations('b', { send: async () => {}, save: save ?? (() => {}) });
}

// Topic routing (VORTEX_v5.1.md §§4–5; skills/vortex/SKILL.md one topic = one thread).
export function routedPair(route: (peer: string, body: string) => Promise<{ conference: string; tier: 'exact' | number; score: number } | undefined>) {
  const pending: { to: string; packet: Packet }[] = [];
  const a = new Conversations('a', { send: async (to,packet) => { pending.push({to,packet}); }, save: () => {} });
  const b = new Conversations('b', { send: async (to,packet) => { pending.push({to,packet}); }, save: () => {}, route });
  const deliver = async () => { while(pending.length) { const p=pending.shift()!; if(p.to==='b') await b.receive('a',p.packet); else await a.receive('b',p.packet); } };
  const connect = async () => { await a.invite('b'); await deliver(); await b.accept(a.roomFor('b')); await deliver(); };
  return {a,b,pending,deliver,connect};
}
