// One command for a development session: `bun start` (package.json "start").
//   1. Vite on 127.0.0.1:5173, unless something already answers there (a `bun run dev` in another terminal).
//   2. `tauri dev` against it — its beforeDevCommand bundles the mod first — which opens the window.
// Ctrl-C (or the window closing) stops what this script started and nothing else. `--check` only reports.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEV_URL = "http://127.0.0.1:5173";
const root = fileURLToPath(new URL("..", import.meta.url));
const bin = (name: string) => fileURLToPath(new URL(`../node_modules/.bin/${name}`, import.meta.url));

async function answering(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(800) });
    return r.status < 500;
  } catch {
    return false;
  }
}

async function waitFor(url: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await answering(url)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const children: ChildProcess[] = [];
function run(cmd: string, args: string[]): ChildProcess {
  const child = spawn(cmd, args, { cwd: root, stdio: "inherit", env: process.env });
  children.push(child);
  return child;
}
function stopAll(): void {
  for (const c of children) if (c.exitCode === null && !c.killed) c.kill("SIGTERM");
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    stopAll();
    process.exit(130);
  });
}

const viteUp = await answering(DEV_URL);
if (process.argv.includes("--check")) {
  console.log(viteUp ? `vite: already answering at ${DEV_URL} — would reuse it` : `vite: not running — would start ${bin("vite")} --config app/vite.config.ts`);
  console.log(`tauri: would run ${bin("tauri")} dev --config {"build":{"devUrl":"${DEV_URL}"}} (beforeDevCommand bundles the mod)`);
  process.exit(0);
}

if (viteUp) {
  console.error(`loki dev: ${DEV_URL} is already answering — using that Vite`);
} else {
  console.error(`loki dev: starting Vite at ${DEV_URL}`);
  const vite = run(bin("vite"), ["--config", "app/vite.config.ts"]);
  vite.on("exit", (code) => {
    // Vite going away takes the session with it: the window would only show a connection error.
    if (children.length > 1) console.error(`loki dev: Vite exited (${code ?? "signal"}); stopping`);
    stopAll();
    process.exit(code ?? 1);
  });
  if (!(await waitFor(DEV_URL, 30_000))) {
    console.error(`loki dev: Vite did not answer at ${DEV_URL} within 30 s`);
    stopAll();
    process.exit(1);
  }
}

const tauri = run(bin("tauri"), ["dev", "--config", JSON.stringify({ build: { devUrl: DEV_URL } })]);
tauri.on("exit", (code) => {
  stopAll(); // Vite too, if this script started it; a Vite from another terminal is not ours to stop
  process.exit(code ?? 0);
});
