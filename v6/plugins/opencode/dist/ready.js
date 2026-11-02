// @bun
// v6/plugins/opencode/ready.ts
import { readFileSync as readFileSync2 } from "fs";

// v6/client/credential.ts
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
function vortexConfigDir() {
  const xdg = process.env.XDG_CONFIG_HOME ?? `${process.env.HOME ?? "/root"}/.config`;
  return `${xdg.replace(/\/$/, "")}/vortex`;
}
function credentialPath(name) {
  return `${vortexConfigDir()}/${name}.json`;
}
function loadCredential(name) {
  const path = credentialPath(name);
  if (!existsSync(path))
    return;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed.hub !== "string" || typeof parsed.token !== "string") {
    throw new Error(`invalid credential file: ${path}`);
  }
  return parsed;
}

// v6/plugins/opencode/ready.ts
var EXIT = { ready: 0, "never-bound": 3, offline: 4, "opencode-unreachable": 5 };
var defaultDeps = { fetch: (input, init) => fetch(input, init), now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
function hubHttp(hub) {
  return hub.replace(/^ws(s?):\/\//, "http$1://").replace(/\/+$/, "");
}
async function activate(o, d) {
  const headers = {};
  if (o.password !== undefined && o.password.length > 0)
    headers.authorization = `Basic ${btoa(`opencode:${o.password}`)}`;
  try {
    const res = await d.fetch(`${o.server.replace(/\/+$/, "")}/api/config?directory=${encodeURIComponent(o.directory)}`, { headers, signal: AbortSignal.timeout(1e4) });
    return res.ok;
  } catch {
    return false;
  }
}
async function bindingStatus(o, d) {
  try {
    const res = await d.fetch(`${hubHttp(o.credential.hub)}/v1/status`, { headers: { authorization: `Bearer ${o.credential.token}` }, signal: AbortSignal.timeout(1e4) });
    if (!res.ok)
      return "hub-error";
    const body = await res.json();
    const principal = o.credential.principal ?? "opencode";
    return (body.bindings ?? []).find((b) => b.principal === principal && b.name === o.binding);
  } catch {
    return "hub-error";
  }
}
async function checkReady(o, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  const deadline = d.now() + o.timeoutMs;
  const poll = o.pollMs ?? 1000;
  let activated = false;
  let last = undefined;
  while (true) {
    if (!activated)
      activated = await activate(o, d);
    if (activated) {
      last = await bindingStatus(o, d);
      if (last !== undefined && last !== "hub-error" && last.open) {
        return { state: "ready", detail: `binding ${last.principal}/${last.name} stream open`, pending: norm(last.pending), lastError: last.lastError };
      }
    }
    if (d.now() + poll > deadline)
      break;
    await d.sleep(poll);
  }
  if (!activated)
    return { state: "opencode-unreachable", detail: `OpenCode at ${o.server} did not answer a directory-scoped request for ${o.directory}` };
  if (last === "hub-error")
    return { state: "offline", detail: `hub ${hubHttp(o.credential.hub)} status unavailable; cannot confirm the stream` };
  if (last === undefined) {
    return { state: "never-bound", detail: `no binding ${o.credential.principal ?? "opencode"}/${o.binding} on the hub: fresh setup, or the plugin is inactive for ${o.directory} (check options.directory, acceptRevisions, credential; OpenCode logs "[vortex] inactive: ...")` };
  }
  const pending = norm(last.pending);
  return { state: "offline", detail: `binding ${last.principal}/${last.name} retained but stream not open; mail queues on the hub (wake ${pending.wake}, passive ${pending.passive})`, pending, lastError: last.lastError };
}
function norm(p) {
  return { wake: p?.wake ?? 0, passive: p?.passive ?? 0 };
}
function parse(argv) {
  const m = new Map;
  for (let i = 0;i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && argv[i + 1] !== undefined) {
      m.set(a.slice(2), argv[i + 1]);
      i++;
    }
  }
  return m;
}
async function main(argv) {
  const f = parse(argv);
  const directory = f.get("directory");
  if (directory === undefined || !directory.startsWith("/")) {
    console.error("vortex-ready: --directory <absolute wake Location> is required");
    return 2;
  }
  let credential;
  try {
    const file = f.get("credential");
    credential = file !== undefined ? JSON.parse(readFileSync2(file, "utf8")) : loadCredential("opencode");
  } catch (e) {
    console.error(`vortex-ready: credential unreadable: ${e.message}`);
    return 2;
  }
  if (credential === undefined || typeof credential.hub !== "string" || typeof credential.token !== "string") {
    console.error("vortex-ready: no opencode credential (run: vx enroll opencode, or pass --credential)");
    return 2;
  }
  const r = await checkReady({
    server: f.get("server") ?? "http://127.0.0.1:4096",
    directory: directory.replace(/\/+$/, "") || "/",
    binding: f.get("binding") ?? "opencode",
    credential,
    timeoutMs: Number(f.get("timeout-ms") ?? 60000),
    password: process.env.OPENCODE_SERVER_PASSWORD
  });
  const line = `vortex-ready: ${r.state}: ${r.detail}${r.lastError ? ` (lastError: ${r.lastError})` : ""}`;
  if (r.state === "ready")
    console.log(line);
  else
    console.error(line);
  return EXIT[r.state];
}
if (import.meta.main)
  process.exit(await main(process.argv.slice(2)));
export {
  EXIT,
  checkReady,
  main
};
