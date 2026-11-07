import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { createMcpHandler, protocolVersion } from './mcp-protocol.ts';


