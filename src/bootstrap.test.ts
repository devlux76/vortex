import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PeerEvent } from './types.ts';
import { connectBootstrap } from './bootstrap.ts';

const ADDR = '/ip4/127.0.0.1/tcp/7811/p2p/12D3KooWBootstrapPeerForRetryTest1';
const PEER = '12D3KooWBootstrapPeerForRetryTest1';

function fakeTransport (dial: (addr: string) => Promise<string>) {
  const handlers: Array<(event: PeerEvent) => void> = [];
  return {
    transport: {
      dial,
      onPeer: (handler: (event: PeerEvent) => void): (() => void) => {
        handlers.push(handler);
        return () => { const at = handlers.indexOf(handler); if (at >= 0) handlers.splice(at, 1); };
      }
    },
    emit: (event: PeerEvent): void => { for (const handler of [...handlers]) handler(event); },
    listenerCount: (): number => handlers.length
  };
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const noop = (): void => {};

// Docs: TODO.md I2; VORTEX_v5.1.md section 7.1
test('a rejected first attempt eventually succeeds without another call', async () => {
  let calls = 0;
  const f = fakeTransport(async () => { calls++; if (calls < 3) throw new Error('down'); return PEER; });
  const stop = connectBootstrap(f.transport, ADDR, noop);
  try {
    const end = Date.now() + 5000;
    while (calls < 3) {
      if (Date.now() > end) throw new Error('bootstrap never retried');
      await sleep(10);
    }
    assert.equal(calls, 3);
  } finally { stop(); }
});

// Docs: TODO.md I2; VORTEX_v5.1.md section 7.1
test('a disconnect from the bootstrap peer redials it', async () => {
  let calls = 0;
  const f = fakeTransport(async () => { calls++; return PEER; });
  const stop = connectBootstrap(f.transport, ADDR, noop);
  try {
    const end = Date.now() + 2000;
    while (calls < 1) {
      if (Date.now() > end) throw new Error('no startup dial');
      await sleep(10);
    }
    f.emit({ kind: 'disconnect', peer: PEER });
    const redialed = Date.now() + 2000;
    while (calls < 2) {
      if (Date.now() > redialed) throw new Error('no redial after disconnect');
      await sleep(10);
    }
    assert.equal(calls, 2);
  } finally { stop(); }
});

// Docs: TODO.md I2; VORTEX_v5.1.md section 7.1
test('a disconnect from any other peer does nothing', async () => {
  let calls = 0;
  const f = fakeTransport(async () => { calls++; return PEER; });
  const stop = connectBootstrap(f.transport, ADDR, noop);
  try {
    const end = Date.now() + 2000;
    while (calls < 1) {
      if (Date.now() > end) throw new Error('no startup dial');
      await sleep(10);
    }
    f.emit({ kind: 'disconnect', peer: '12D3KooWSomeUnrelatedPeerForTest' });
    f.emit({ kind: 'connect', peer: PEER });
    await sleep(300);
    assert.equal(calls, 1);
  } finally { stop(); }
});

// Docs: TODO.md I2; VORTEX_v5.1.md section 7.1
test('repeated disconnects never overlap attempts and none is lost', async () => {
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<string>(resolve => { release = () => resolve(PEER); });
  const f = fakeTransport(() => { calls++; return gate; });
  const stop = connectBootstrap(f.transport, ADDR, noop);
  try {
    const end = Date.now() + 2000;
    while (calls < 1) {
      if (Date.now() > end) throw new Error('no startup dial');
      await sleep(10);
    }
    f.emit({ kind: 'disconnect', peer: PEER });
    f.emit({ kind: 'disconnect', peer: PEER });
    f.emit({ kind: 'disconnect', peer: PEER });
    await sleep(150);
    assert.equal(calls, 1);
    release();
    const retried = Date.now() + 3000;
    while (calls < 2) {
      if (Date.now() > retried) throw new Error('lost disconnect during pending dial');
      await sleep(10);
    }
    await sleep(300);
    assert.equal(calls, 2);
  } finally { stop(); }
});

// Docs: TODO.md I2; VORTEX_v5.1.md section 7.1
test('stop prevents further retries and late callbacks schedule nothing', async () => {
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<string>((_, reject) => { release = () => reject(new Error('down')); });
  const errors: string[] = [];
  const f = fakeTransport(() => { calls++; return gate; });
  const stop = connectBootstrap(f.transport, ADDR, (message) => errors.push(message));
  try {
    const end = Date.now() + 2000;
    while (calls < 1) {
      if (Date.now() > end) throw new Error('no startup dial');
      await sleep(10);
    }
    stop();
    assert.equal(f.listenerCount(), 0);
    release();
    await sleep(400);
    assert.equal(calls, 1);
    f.emit({ kind: 'disconnect', peer: PEER });
    await sleep(200);
    assert.equal(calls, 1);
  } finally { stop(); }
});

// Docs: TODO.md I2; VORTEX_v5.1.md section 7.1
test('success resets the backoff for the next redial', async () => {
  let calls = 0;
  const f = fakeTransport(async () => {
    calls++;
    if (calls <= 3) throw new Error('down');
    return PEER;
  });
  const stop = connectBootstrap(f.transport, ADDR, noop);
  try {
    const up = Date.now() + 8000;
    while (calls < 4) {
      if (Date.now() > up) throw new Error('bootstrap never succeeded');
      await sleep(10);
    }
    f.emit({ kind: 'disconnect', peer: PEER });
    const before = Date.now();
    const redialed = Date.now() + 5000;
    while (calls < 5) {
      if (Date.now() > redialed) throw new Error('no redial after disconnect');
      await sleep(10);
    }
    // Three failures back off 100+200+400ms; a reset redials near 100ms, stale state near 800ms.
    assert.ok(Date.now() - before < 500, `redial took ${Date.now() - before}ms without a reset`);
  } finally { stop(); }
});
