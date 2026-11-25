import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const resources = process.env.LOKI_SMOKE_RESOURCES ?? join(repo, "desktop", "resources");
const daemonEntry = join(resources, "daemon", "daemon.mjs");
const modEntry = join(resources, "mod", "loki-mod.mjs");
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
    } catch {}
    await sleep(250);
  }
  await stop();
  throw new Error(`the daemon did not answer /health within ${START_MS / 1000}s:\n${output}`);
}

type Reply = { type: string; request_id?: string; message?: string } & Record<string, unknown>;

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

const OURS = /Cannot find module|ERR_MODULE_NOT_FOUND|is not a function|is not defined|Cannot read properties|is not supported/;

async function agents(sock: Awaited<ReturnType<typeof connect>>) {
  const r = await sock.request("chat_agents");
  if (r.type !== "chat_agents") throw new Error(`chat_agents: ${r.message ?? r.type}`);
  return r.agents as Array<{ id: string; name: string }>;
}

async function main(): Promise<void> {
  for (const f of [daemonEntry, modEntry]) if (!existsSync(f)) throw new Error(`${f} is missing: run bun run build:mod first`);
  const home = mkdtempSync(join(tmpdir(), "loki-smoke-"));
  console.log(`smoke: the bundle in ${resources}, home ${home}`);
  let daemon: Daemon | null = null;
  let earlier = "";
  try {
    try {
      const ran = execFileSync(process.execPath, [daemonEntry, "--check-scripts"], {
        cwd: home,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: START_MS,
      });
      if (ran.includes("1 + 1 = 2")) ok("the bundled daemon runs a script in its sandbox");
      else fail(`the bundled daemon's script check said: ${ran.trim()}`);
    } catch (e) {
      fail(`the bundled daemon could not run a script: ${e instanceof Error ? e.message : String(e)}`);
    }
    daemon = await start(home);
    ok("the bundled daemon starts and serves /health");
    let sock = await connect(home, daemon.port);
    ok("the socket takes the token");

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
    if (typeof created.id === "string" && after.some((a) => a.id === created.id)) ok("the agent made before is there after a restart");
    else fail(`the agent made before is gone after a restart (agents: ${JSON.stringify(after)})`);
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
      // Outside (Windows): it may hold a file of the killed daemon's a moment longer; the scratch folder is the system's to clear.
    }
  }
  if (failures) {
    console.log(`smoke: ${failures} failed`);
    process.exit(1);
  }
  console.log("smoke: the bundle works");
}

const ELECTRON_START_MS = 120_000;
const ELECTRON_STOP_MS = 20_000;
const ELECTRON_SMOKE_PORT = 41499;

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e instanceof Error && "code" in e && e.code === "EPERM";
  }
};

async function answersHealth(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

async function until(what: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await what()) return true;
    await sleep(250);
  }
  return what();
}

function stopApp(app: ChildProcess): void {
  if (app.pid === undefined) return;
  if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(app.pid)], { stdio: "ignore" });
  else app.kill("SIGTERM");
}

async function electronSmoke(given: string): Promise<void> {
  const exe = resolve(given);
  if (!given || !existsSync(exe)) throw new Error(`${exe} is missing: package the app first (bun run dist --dir)`);
  const port = Number(process.env.LOKI_SMOKE_PORT ?? ELECTRON_SMOKE_PORT);
  if (!(await portIsFree(port))) throw new Error(`port ${port} is taken: stop what uses it, or set LOKI_SMOKE_PORT`);
  const home = mkdtempSync(join(tmpdir(), "loki-electron-smoke-"));
  const dir = join(home, ".loki");
  console.log(`smoke: the packaged app ${exe}, home ${home}, port ${port}`);
  let output = "";
  const app = spawn(exe, [`--user-data-dir=${join(home, "electron")}`], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      XDG_CONFIG_HOME: join(home, ".config"),
      LOKI_PORT: String(port),
      LOKI_LAN_PORT: "0",
      LOKI_ANALYTICS: "0",
      LOKI_UPDATE_URL: "http://127.0.0.1:9/desktop.json",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.on("data", (d: Buffer) => (output += d.toString()));
  app.stderr.on("data", (d: Buffer) => (output += d.toString()));
  const launch: { error: Error | null } = { error: null };
  const exited = new Promise<number | null>((done) => {
    app.once("exit", (code) => done(code));
    app.once("error", (error) => {
      launch.error = error;
      done(null);
    });
  });
  const running = () => launch.error === null && app.exitCode === null && app.signalCode === null;
  const daemonLog = () => {
    try {
      return readFileSync(join(dir, "logs", "daemon.log"), "utf8");
    } catch {
      return "";
    }
  };
  let daemonPid: number | null = null;
  try {
    const healthy = await until(async () => !running() || (await answersHealth(port)), ELECTRON_START_MS);
    if (launch.error) throw new Error(`the app did not start: ${launch.error.message}`);
    if (!running()) throw new Error(`the app exited with ${String(app.exitCode ?? app.signalCode)} before its daemon answered`);
    if (!healthy) throw new Error(`the app's daemon did not answer /health on port ${port} within ${ELECTRON_START_MS / 1000}s`);
    ok("the packaged app starts its daemon, which serves /health");
    daemonPid = Number.parseInt(readFileSync(join(dir, "daemon.lock"), "utf8"), 10);
    if (!Number.isInteger(daemonPid) || daemonPid <= 0) throw new Error("the daemon wrote no pid to ~/.loki/daemon.lock");
    stopApp(app);
    const code = await Promise.race([exited, sleep(ELECTRON_STOP_MS).then(() => "running" as const)]);
    if (code === "running") throw new Error(`the app was still running ${ELECTRON_STOP_MS / 1000}s after it was asked to quit`);
    ok(`the app quits when asked (exit ${String(code ?? app.signalCode)})`);
    const pid = daemonPid;
    if (await until(() => !isAlive(pid), ELECTRON_STOP_MS)) ok("its daemon stops with it");
    else fail(`the daemon (pid ${pid}) is still running after the app quit`);
    if (await answersHealth(port)) fail(`something still answers /health on port ${port} after the app quit`);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  } finally {
    if (failures) console.log(`--- the app's output ---\n${output}\n--- the daemon's log ---\n${daemonLog()}`);
    if (running()) {
      app.kill("SIGKILL");
      await Promise.race([exited, sleep(5000)]);
    }
    if (daemonPid !== null && isAlive(daemonPid)) process.kill(daemonPid, "SIGKILL");
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // Outside (Windows): it may hold a file of the stopped app's a moment longer; the scratch folder is the system's to clear.
    }
  }
  if (failures) {
    console.log(`smoke: ${failures} failed`);
    process.exit(1);
  }
  console.log("smoke: the packaged app works");
}

function packagedApp(): string {
  const release = join(repo, "desktop", "release");
  if (process.platform === "darwin") return join(release, process.arch === "arm64" ? "mac-arm64" : "mac", "loki.app", "Contents", "MacOS", "loki");
  if (process.platform === "win32") return join(release, "win-unpacked", "loki.exe");
  return join(release, "linux-unpacked", "loki");
}

const electronAt = process.argv.indexOf("--electron");
const named = process.argv.at(electronAt + 1);
if (electronAt === -1) await main();
else
  await electronSmoke(named === undefined || named.startsWith("--") ? packagedApp() : named).catch((e: unknown) => {
    fail(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
