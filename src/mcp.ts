/** Owner-local stdio adapter. It attaches to a service; it never launches an agent or a network service. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { createMcpHandler } from './mcp-protocol.ts';

const { values } = parseArgs({ options: { dir: { type: 'string', default: '.vortex/codex' } } });
const dir = resolve(values.dir!);
const handler = createMcpHandler(async (operation, args, signal) => {
  // Read current credentials for each call so a service restart does not require an adapter restart.
  const endpoint = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8'));
  if (typeof endpoint.url !== 'string' || !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(endpoint.url) ||
      typeof endpoint.token !== 'string' || !/^[0-9a-f]{64}$/.test(endpoint.token)) throw Error('Invalid local service endpoint');
  const response = await fetch(endpoint.url + '/' + operation, { method: 'POST', redirect: 'error',
    headers: { authorization: 'Bearer ' + endpoint.token, 'content-type': 'application/json' },
    body: JSON.stringify(args), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(65000)]) : AbortSignal.timeout(65000) });
  const data = await response.json();
  if (!response.ok) throw Error(data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
    ? data.error : 'Local service request failed');
  return data;
});
const active = new Map<string | number, AbortController>();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value: unknown) => { process.stdout.write(JSON.stringify(value) + '\n'); };
const error = (code: number, message: string, id?: string | number) => send({ jsonrpc: '2.0',
  ...(id === undefined ? {} : { id }), error: { code, message } });
lines.on('line', line => {
  if (Buffer.byteLength(line) > 128 * 1024) { error(-32600, 'Request exceeds 128 KiB'); return; }
  let value: unknown;
  try { value = JSON.parse(line); } catch { error(-32700, 'Parse error'); return; }
  const request = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (request?.jsonrpc === '2.0' && request.method === 'notifications/cancelled' && !('id' in request)) {
    const params = request.params as { requestId?: unknown } | undefined;
    if (typeof params?.requestId === 'string' || Number.isSafeInteger(params?.requestId)) {
      const id = params!.requestId as string | number;
      active.get(id)?.abort(); active.delete(id);
    }
    return;
  }
  const id = typeof request?.id === 'string' || Number.isSafeInteger(request?.id) ? request!.id as string | number : undefined;
  if (id !== undefined && active.has(id)) { error(-32600, 'Request ID is already in flight', id); return; }
  if (active.size >= 32 && id !== undefined) { error(-32603, 'Too many requests in flight', id); return; }
  const controller = new AbortController();
  if (id !== undefined) active.set(id, controller);
  void handler(value, controller.signal).then(response => {
    if (response !== undefined && !controller.signal.aborted) send(response);
  }).catch(() => { if (!controller.signal.aborted) error(-32603, 'MCP request failed', id); }).finally(() => {
    if (id !== undefined && active.get(id) === controller) active.delete(id);
  });
});
const stop = () => {
  for (const controller of active.values()) controller.abort();
  active.clear(); lines.close(); process.stdin.destroy();
};
lines.once('close', stop);
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
