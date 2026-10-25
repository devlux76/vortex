/** Node boundary for an owner-selected startup file and approval program. No peer controls either. */
import { accessSync, constants, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createDisclosurePolicy, parseDisclosureConfig } from './core/disclosure.ts';
import type { DisclosureCheck, DisclosureRequest } from './core/disclosure.ts';

export function loadDisclosurePolicy(path: string): DisclosureCheck {
  let value: unknown;
  try {
    const bytes = readFileSync(path);
    if (bytes.length > 65536) throw Error();
    value = JSON.parse(bytes.toString('utf8'));
  } catch { throw Error('invalid disclosure policy file'); }
  const config = parseDisclosureConfig(value);
  const cwd = dirname(resolve(path));
  const command = config.approvalCommand === undefined ? undefined : resolve(cwd, config.approvalCommand);
  if (config.requireApproval && command) {
    try { accessSync(command, constants.X_OK); } catch { throw Error('invalid disclosure policy approval executable'); }
  }
  const approve = command === undefined ? undefined : (request: DisclosureRequest) => new Promise<void>((resolve, reject) => {
    const child = spawn(command, [], { cwd, stdio: ['pipe', 'ignore', 'ignore'] });
    let finished = false;
    const finish = (allowed: boolean) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (!allowed) child.kill('SIGKILL');
      if (allowed) resolve(); else reject(Error('approval declined or unavailable'));
    };
    const timer = setTimeout(() => finish(false), 30000);
    child.once('error', () => finish(false));
    child.once('exit', code => finish(code === 0));
    child.stdin.once('error', () => finish(false));
    child.stdin.end(JSON.stringify(request) + '\n');
  });
  return createDisclosurePolicy(config, approve);
}
