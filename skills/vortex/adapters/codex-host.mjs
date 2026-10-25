import { readdirSync, readFileSync, statSync } from 'node:fs';

// A headless `codex exec` is not an app host. Do not let it swallow its own ring.
export function isAppHost(name, args) {
  return (['ChatGPT', 'chatgpt', 'Codex'].includes(name) && !args.some(a=>a.startsWith('--type='))) ||
    (name === 'codex' && args[1] === 'app-server');
}
export function hostRunning(selected = process.env.VORTEX_CODEX_HOST_PID) {
  const alive = pid => {
    try {
      const text=readFileSync(`/proc/${pid}/stat`,'utf8');
      return !['Z','X'].includes(text.slice(text.lastIndexOf(')')+2).split(' ')[0]) &&
        statSync(`/proc/${pid}`).uid === process.getuid();
    } catch {return false;}
  };
  // Optional owner-selected app host, useful when multiple desktops are running.
  if(selected !== undefined) {
    if(!/^[1-9][0-9]*$/.test(selected) || !Number.isSafeInteger(Number(selected))) throw Error('invalid VORTEX_CODEX_HOST_PID');
    return alive(Number(selected));
  }
  return readdirSync('/proc').some(pid=>{
    if(!/^[0-9]+$/.test(pid)||!alive(pid)) return false;
    try {return isAppHost(readFileSync(`/proc/${pid}/comm`,'utf8').trim(),readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0'));}
    catch {return false;}
  });
}
