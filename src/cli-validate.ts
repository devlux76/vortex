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
export const failJson = (body: { error: string, got: string, example: string }): never => {
  writeSync(1, JSON.stringify(body) + '\n');
  process.exit(1);
};

// Owner feedback never accepts caller-supplied provenance or embeddings.
export function feedbackArgs(args: Record<string, unknown>): ConferenceFeedback | undefined {
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

export const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// A --peer is either a bare peer id or a multiaddr that parses and ends in
// /p2p/<peer id>. Returns the one-sentence problem, or null when valid.
export function peerProblem (value: string | undefined): string | null {
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
export function roomProblem (value: string | undefined): string | null {
  if (value === undefined) return '--room is missing: give the conversation room';
  try {
    const room = JSON.parse(value);
    if (Array.isArray(room) && room.length === 2 && typeof room[0] === 'string' && typeof room[1] === 'string') return null;
    return '--room must be a JSON array of two peer ids';
  } catch {
    return '--room is not valid JSON';
  }
}

export const ROOM_EX = `'["12D3KooWAAA","12D3KooWBBB"]'`;
export const ID_EX = `'${'a'.repeat(32)}'`;
export const HEX_ID = /^[0-9a-f]{32}$/;
// An --id or --replaces naming an announcement, or null when valid.
export function idProblem (value: string | undefined, flag: string): string | null {
  if (value === undefined) return `${flag} is missing: give the announcement id`;
  if (!HEX_ID.test(value)) return `${flag} must be 32 lowercase hexadecimal characters`;
  return null;
}
// A --ttl in seconds, or null when valid.
export function ttlProblem (value: string | undefined): string | null {
  if (value === undefined) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 3600) return '--ttl must be an integer from 1 to 3600 seconds';
  return null;
}
// A subscription --ttl in seconds: required, bounded by the absolute operator maximum (604800).
// The service enforces its own configured maximum on top.
export function subscriptionTtlProblem (value: string | undefined): string | null {
  if (value === undefined) return '--ttl is missing: give the subscription lifetime in seconds';
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 604800) return '--ttl must be an integer from 1 to 604800 seconds';
  return null;
}
// The cursor of the last event a read or wait returned, for `ack --cursor read`.
export let lastDelivered = 0;
export const delivered = <T extends { cursor: number }>(page: T): T => { lastDelivered = Math.max(lastDelivered, page.cursor); return page; };

export function validateArgs (op: string, v: { peer?: string, room?: string, text?: string, cursor?: string,
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
