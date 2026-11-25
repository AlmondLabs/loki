import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { watch } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPage, pageStale } from "../daemon/page-build.ts";
import { buildDesktop, DESKTOP_OUT } from "./build-desktop.ts";

const DEV_PORT = 5173;
const DEV_URL = `http://127.0.0.1:${DEV_PORT}`;
const hot = process.argv.includes("--hot");
const command = hot ? "bun run dev" : "bun run start";
const VITE_MARKER = 'name="apple-mobile-web-app-title" content="loki"';
const MOD_HEALTH = `http://127.0.0.1:${process.env.LOKI_PORT ?? "41414"}/health`;
const MOD_WAIT_MS = 90_000;
const root = fileURLToPath(new URL("..", import.meta.url));
const windows = process.platform === "win32";
// Outside (Windows): node_modules/.bin holds .cmd shims, which spawn cannot start without a shell, so the JS entry
// runs directly with this script's runtime.
const ENTRIES: Record<string, string> = { vite: "../node_modules/vite/bin/vite.js" };
const bin = (name: string) => fileURLToPath(new URL(windows ? ENTRIES[name] : `../node_modules/.bin/${name}`, import.meta.url));
// Outside (Electron): its package fetches the binary in a postinstall script, which bun does not always run, and
// `require("electron")` then throws; running that script once more fetches it.
function electronBinary(): string {
  const load = () => createRequire(import.meta.url)("electron") as string;
  try {
    return load();
  } catch {
    console.error("loki dev: fetching Electron's binary, once");
    spawnSync(process.execPath, [fileURLToPath(new URL("../node_modules/electron/install.js", import.meta.url))], { stdio: "inherit" });
    return load();
  }
}
const electron = electronBinary();
const home = homedir();
const daemonLog = join(home, ".loki", "logs", "daemon.log");

async function answering(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(800) });
    return r.status < 500;
  } catch {
    return false;
  }
}

async function viteThere(url: string): Promise<"ours" | "other" | "none"> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(800) });
    if (r.status >= 500) return "none";
    return (await r.text()).includes(VITE_MARKER) ? "ours" : "other";
  } catch {
    return "none";
  }
}

async function waitFor(url: string, ms: number, alive: () => boolean = () => true): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until && alive()) {
    if (await answering(url)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const children: ChildProcess[] = [];
let env = process.env;
function run(cmd: string, args: string[], direct = false): ChildProcess {
  const child =
    windows && !direct ? spawn(process.execPath, [cmd, ...args], { cwd: root, stdio: "inherit", env }) : spawn(cmd, args, { cwd: root, stdio: "inherit", env });
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

const vite = hot ? await viteThere(DEV_URL) : "none";
const electronArgs = [join(DESKTOP_OUT, "main.cjs")];
if (process.argv.includes("--check")) {
  console.log(`electron: would bundle desktop/ into ${DESKTOP_OUT} and run ${electron} ${electronArgs.join(" ")}`);
  console.log(`node: ${process.version} at ${process.execPath}`);
  if (hot) {
    console.log(
      vite === "ours"
        ? `vite: loki's, already answering at ${DEV_URL} — would reuse it`
        : vite === "other"
          ? `vite: something else answers at ${DEV_URL} — \`${command}\` would stop`
          : `vite: not running — would start ${bin("vite")} --config app/vite.config.ts`,
    );
    console.log(`phone: would run ${bin("vite")} build --watch --emptyOutDir=false --config app/vite.config.ts, so app/dist follows the code`);
  } else {
    console.log(`page: ${pageStale(root) ? "app/dist older than its sources — would build it" : "app/dist up to date"}, served to the window from loki://app`);
  }
  console.log(
    `mod: ${(await answering(MOD_HEALTH)) ? "answering" : "not answering"} at ${MOD_HEALTH} — would wait up to ${MOD_WAIT_MS / 1000} s after the window starts the daemon`,
  );
  process.exit(0);
}

env = { ...process.env };
if (hot) {
  delete env.LOKI_BUILT_PAGE;
  env.LOKI_DEV_URL = DEV_URL;
} else {
  env.LOKI_BUILT_PAGE = "1";
  delete env.LOKI_DEV_URL;
}

if (vite === "other") {
  console.error(
    [
      `loki dev: something else is answering at ${DEV_URL} — another project's dev server, not loki's Vite (its page lacks loki's title).`,
      `  The window would show that page. Stop that server, or start it on another port, then \`${command}\` again.`,
    ].join("\n"),
  );
  process.exit(1);
}
if (!hot) {
  if (pageStale(root)) {
    console.error("loki dev: building the page (app/dist), about fifteen seconds");
    const failed = await buildPage(root);
    if (failed) {
      console.error(`loki dev: the page did not build:\n${failed}`);
      process.exit(1);
    }
  }
  console.error("loki dev: the window shows the built page (app/dist) and reloads when update rebuilds it");
} else if (vite === "ours") {
  console.error(`loki dev: loki's Vite is already answering at ${DEV_URL} — using it`);
} else {
  console.error(`loki dev: starting Vite at ${DEV_URL}`);
  const vite = run(bin("vite"), ["--config", "app/vite.config.ts"]);
  vite.on("exit", (code) => {
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

await buildDesktop();
const shell = run(electron, electronArgs, true);
shell.on("exit", (code) => {
  stopAll();
  process.exit(code ?? 0);
});

if (hot) watchPhoneBuild();

function watchPhoneBuild(): void {
  console.error("loki dev: rebuilding the phone's app (app/dist) as the code changes");
  // Outside (Vite): a build watch reads its config once, unlike the dev server, so a change to app/vite.config.ts
  // starts it afresh.
  let phoneBuild: ChildProcess;
  let restarting = false;
  const startPhoneBuild = () => {
    phoneBuild = run(bin("vite"), ["build", "--watch", "--emptyOutDir=false", "--logLevel", "error", "--config", "app/vite.config.ts"]);
    phoneBuild.on("exit", (code) => {
      if (restarting) return;
      if (shell.exitCode === null)
        console.error(`loki dev: the phone's build watch exited (${code ?? "signal"}); run \`bun run build:app\` after phone changes`);
    });
  };
  startPhoneBuild();
  let configTimer: ReturnType<typeof setTimeout> | null = null;
  watch(join(root, "app", "vite.config.ts"), () => {
    if (configTimer) clearTimeout(configTimer);
    configTimer = setTimeout(() => {
      if (shell.exitCode !== null) return;
      console.error("loki dev: app/vite.config.ts changed — restarting the phone's build watch");
      restarting = true;
      phoneBuild.once("exit", () => {
        restarting = false;
        startPhoneBuild();
      });
      phoneBuild.kill("SIGTERM");
    }, 300);
  });
}

void (async () => {
  const alive = () => shell.exitCode === null;
  const modUp = await waitFor(MOD_HEALTH, MOD_WAIT_MS, alive);
  if (modUp || !alive()) return;
  console.error(
    [
      `loki dev: the mod is not answering at ${MOD_HEALTH} after ${MOD_WAIT_MS / 1000} s, so the desk has nothing to link to`,
      `  ${hot ? '(Vite\'s "ws proxy error" lines above are that). ' : ""}The mod runs inside loki's daemon, which the window starts on a Node 22.19+;`,
      `  the window's own output above says whether it found one, and the daemon's log is ${daemonLog}.`,
    ].join("\n"),
  );
})();
