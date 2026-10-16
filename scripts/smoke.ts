// The release smoke test: `npm run build:mod && npm run smoke`. CI tests the sources; people run the bundle
// (src-tauri/resources/daemon/daemon.mjs and mod/loki-mod.mjs). Two bugs reached people that way on 2026-10-11:
// every sign-in failed in the bundle (a module pi-ai loads by a variable path was not in it), and agents went missing
// after an upgrade. This starts the bundled daemon the way the shell does (src-tauri/src/harness.rs), in a scratch
// home that holds a Letta-era agent, and asks it over its socket what the app would:
//   - it starts, serves /health and takes the token
//   - the Letta agent was imported on its own, and an agent made now is still there after a restart
//   - every provider that signs in names its page (a provider unreachable from here only warns; a missing module or
//     any other error in loki's own code fails)
// Nothing outside the scratch folder is touched: HOME, USERPROFILE and LOKI_DIR point into it, analytics are off.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { backendName } from "../core/desk-core.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const resources = process.env.LOKI_SMOKE_RESOURCES ?? join(repo, "src-tauri", "resources");
const daemonEntry = join(resources, "daemon", "daemon.mjs");
const modEntry = join(resources, "mod", "loki-mod.mjs");
const LETTA_AGENT = "agent-local-smoke-letta";
const START_MS = 30_000;
const REQUEST_MS = 20_000;

let failures = 0;
const ok = (what: string) => console.log(`  ok    ${what}`);
const warn = (what: string) => console.log(`::warning title=smoke::${what}`);
const fail = (what: string) => {
  failures++;
  console.log(`::error title=smoke::${what}`);
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Daemon {
  child: ChildProcess;
  port: number;
  log: () => string;
  stop: () => Promise<void>;
}

async function start(home: string): Promise<Daemon> {
  const port = await freePort();
  const dir = join(home, ".loki");
  const tokenFile = join(dir, "token");
  let output = "";
  const child = spawn(process.execPath, [daemonEntry, "--loki-daemon", "--dir", dir, "--mod", modEntry, "--token-file", tokenFile], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      LOKI_DIR: dir,
      LOKI_PORT: String(port),
      LOKI_LAN_PORT: "0",
      LOKI_ANALYTICS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr.on("data", (d: Buffer) => (output += d.toString()));
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  const running = () => child.exitCode === null && child.signalCode === null;
  const stop = async () => {
    if (!running()) return;
    child.kill();
    await Promise.race([exited, sleep(5000)]);
    if (running()) child.kill("SIGKILL");
  };
  const deadline = Date.now() + START_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the daemon exited with ${child.exitCode}:\n${output}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok && existsSync(tokenFile)) return { child, port, log: () => output, stop };
    } catch {
      // not listening yet
    }
    await sleep(250);
  }
  await stop();
  throw new Error(`the daemon did not answer /health within ${START_MS / 1000}s:\n${output}`);
}

type Reply = { type: string; request_id?: string; message?: string } & Record<string, unknown>;

/** A socket to the daemon, as the app holds one: requests carry a request_id, answered by their reply or an `error`. */
async function connect(home: string, port: number) {
  const token = readFileSync(join(home, ".loki", "token"), "utf8").trim();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?t=${encodeURIComponent(token)}`);
  const waiting = new Map<string, (r: Reply) => void>();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data)) as Reply;
    const answer = m.request_id ? waiting.get(m.request_id) : undefined;
    if (m.request_id && answer) {
      answer(m);
      waiting.delete(m.request_id);
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("the socket refused the token")), { once: true });
  });
  let n = 0;
  const request = (type: string, payload: Record<string, unknown> = {}): Promise<Reply> => {
    const requestId = `smoke-${++n}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        waiting.delete(requestId);
        reject(new Error(`${type}: no reply in ${REQUEST_MS / 1000}s`));
      }, REQUEST_MS);
      waiting.set(requestId, (r) => {
        clearTimeout(t);
        resolve(r);
      });
      ws.send(JSON.stringify({ type, request_id: requestId, ...payload }));
    });
  };
  return { request, close: () => ws.close() };
}

/** A Letta-era Mac: an agent in ~/.letta's local backend, as letta-code kept it (a record and a memory folder). */
function seedLetta(home: string): void {
  const file = join(home, ".letta", "lc-local-backend", "agents", `${backendName(LETTA_AGENT)}.json`);
  mkdirSync(join(file, ".."), { recursive: true });
  const memory = join(home, ".letta", "lc-local-backend", "memfs", LETTA_AGENT, "memory");
  mkdirSync(memory, { recursive: true });
  writeFileSync(join(memory, "persona.md"), "I came over from Letta.\n");
  writeFileSync(
    file,
    JSON.stringify({
      id: LETTA_AGENT,
      name: "From Letta",
      description: null,
      system: "",
      tags: ["origin:letta-code"],
      model: "openrouter/some-model",
      model_settings: {},
      hidden: false,
    }),
  );
}

/** Errors in loki's own code, as opposed to a provider this runner cannot reach. */
const OURS = /Cannot find module|ERR_MODULE_NOT_FOUND|is not a function|is not defined|Cannot read properties|is not supported/;

async function agents(sock: Awaited<ReturnType<typeof connect>>) {
  const r = await sock.request("chat_agents");
  if (r.type !== "chat_agents") throw new Error(`chat_agents: ${r.message ?? r.type}`);
  return r.agents as Array<{ id: string; name: string }>;
}

async function main(): Promise<void> {
  for (const f of [daemonEntry, modEntry]) if (!existsSync(f)) throw new Error(`${f} is missing: run npm run build:mod first`);
  const home = mkdtempSync(join(tmpdir(), "loki-smoke-"));
  console.log(`smoke: the bundle in ${resources}, home ${home}`);
  seedLetta(home);
  let daemon: Daemon | null = null;
  let earlier = "";
  try {
    daemon = await start(home);
    ok("the bundled daemon starts and serves /health");
    let sock = await connect(home, daemon.port);
    ok("the socket takes the token");

    // The import runs on its own at start; give it a moment.
    let list: Array<{ id: string; name: string }> = [];
    for (let i = 0; i < 40; i++) {
      list = await agents(sock);
      if (list.some((a) => a.id === LETTA_AGENT)) break;
      await sleep(250);
    }
    if (list.some((a) => a.id === LETTA_AGENT)) ok("the Letta-era agent was imported");
    else fail(`the Letta-era agent was not imported (agents: ${JSON.stringify(list)})`);

    const created = await sock.request("chat_agent_create", { name: "Smoke" });
    if (created.type !== "chat_agent_created") fail(`chat_agent_create: ${created.message ?? created.type}`);
    else ok("an agent can be made");

    const providers = await sock.request("chat_providers");
    if (providers.type !== "chat_providers") fail(`chat_providers: ${providers.message ?? providers.type}`);
    else {
      const all = providers.providers as Array<{ id: string; auth_methods: Array<{ id: string }> }>;
      const signsIn = all.filter((p) => p.auth_methods.some((m) => m.id === "oauth"));
      ok(`${all.length} providers listed, ${signsIn.length} sign in`);
      if (signsIn.length === 0) fail("no provider offers sign-in: the sign-in flows did not load");
      for (const p of signsIn) {
        const r = await sock.request("chat_provider_signin", { provider_id: p.id }).catch((e: unknown): Reply => ({ type: "error", message: String(e) }));
        if (r.type === "chat_signin" && typeof r.url === "string" && /^https?:\/\//.test(r.url)) ok(`sign-in to ${p.id} names its page`);
        else if (OURS.test(String(r.message))) fail(`sign-in to ${p.id}: ${r.message}`);
        else warn(`sign-in to ${p.id} did not name a page from this runner: ${r.message ?? r.type}`);
      }
    }

    const usage = await sock.request("usage_get", { since: new Date(Date.now() - 7 * 86_400_000).toISOString(), until: new Date().toISOString() });
    if (usage.type !== "usage" || !Array.isArray(usage.rows) || typeof usage.seeded_until !== "string")
      fail(`usage_get: ${usage.message ?? JSON.stringify(usage)}`);
    else ok("the usage ledger answers, its history seeded");

    sock.close();
    await daemon.stop();
    earlier = daemon.log();
    daemon = await start(home);
    sock = await connect(home, daemon.port);
    const after = await agents(sock);
    for (const [id, name] of [
      [LETTA_AGENT, "the Letta-era agent"],
      [created.id, "the agent made before"],
    ] as const)
      if (typeof id === "string" && after.some((a) => a.id === id)) ok(`${name} is there after a restart`);
      else fail(`${name} is gone after a restart (agents: ${JSON.stringify(after)})`);
    sock.close();

    const log = earlier + daemon.log();
    for (const line of log.split("\n")) if (OURS.test(line)) fail(`the daemon logged: ${line.trim()}`);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  } finally {
    if (failures) console.log(`--- the daemon's output ---\n${earlier}${daemon?.log() ?? ""}`);
    await daemon?.stop();
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // Windows may hold a file of the killed daemon's a moment longer; the scratch folder is the system's to clear
    }
  }
  if (failures) {
    console.log(`smoke: ${failures} failed`);
    process.exit(1);
  }
  console.log("smoke: the bundle works");
}

await main();
