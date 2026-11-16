import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPage, pageStale } from "../daemon/page-build.ts";

const DEV_PORT = 5173;
const DEV_URL = `http://127.0.0.1:${DEV_PORT}`;
const hot = process.argv.includes("--hot");
const command = hot ? "npm run dev" : "npm start";
const VITE_MARKER = 'name="apple-mobile-web-app-title" content="loki"';
const MOD_HEALTH = `http://127.0.0.1:${process.env.LOKI_PORT ?? "41414"}/health`;
const MOD_WAIT_MS = 90_000;
const root = fileURLToPath(new URL("..", import.meta.url));
const windows = process.platform === "win32";
const mac = process.platform === "darwin";
const exeNames = (name: string): string[] => (windows ? [`${name}.exe`, `${name}.cmd`, name] : [name]);
/**
 * The dev tools' entry scripts. On Windows node_modules/.bin holds .cmd shims, which spawn cannot start without a
 * shell, so there the JS entry runs directly with this script's runtime (see `run`).
 */
const ENTRIES: Record<string, string> = { vite: "../node_modules/vite/bin/vite.js", tauri: "../node_modules/@tauri-apps/cli/tauri.js" };
const bin = (name: string) => fileURLToPath(new URL(windows ? ENTRIES[name] : `../node_modules/.bin/${name}`, import.meta.url));
const home = homedir();
const daemonLog = join(home, ".loki", "logs", "daemon.log");

function onPath(name: string, path = process.env.PATH ?? ""): string | null {
  for (const dir of path.split(delimiter)) {
    for (const n of exeNames(name)) if (dir && existsSync(join(dir, n))) return join(dir, n);
  }
  return null;
}

/**
 * The Rust toolchain: `tauri dev` runs `cargo metadata` first and dies with a bare "No such file or directory"
 * without it. rustup installs to ~/.cargo/bin and only the next shell sees it, so look there too and use it.
 * Returns the PATH the children should run with, or null after printing what to install.
 */
function rustPreflight(): string | null {
  const path = process.env.PATH ?? "";
  if (onPath("cargo", path)) return path;
  const cargoBin = join(home, ".cargo", "bin");
  if (onPath("cargo", cargoBin)) {
    console.error(`loki dev: cargo is at ${cargoBin} but not on PATH (a new terminal would have it) — using it for this run`);
    return `${cargoBin}${delimiter}${path}`;
  }
  console.error(
    [
      "loki dev: the Tauri window is a Rust program and this machine has no Rust toolchain (no `cargo` on PATH, none in ~/.cargo/bin).",
      `  Install it, then open a new terminal${windows ? "" : " (or `source ~/.cargo/env`)"} and run \`${command}\` again:`,
      windows
        ? "    winget install Rustlang.Rustup   (rustup-init also offers the Visual Studio C++ build tools cargo links with)"
        : "    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
      ...(mac ? ["  Building also needs Xcode's command line tools: `xcode-select --install` if clang is missing."] : []),
      "  Without Rust, `npm run dev:vite` serves the canvas alone at " + DEV_URL + " for a browser tab.",
    ].join("\n"),
  );
  return null;
}

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

/**
 * Xcode's command line tools: cargo links through them, and without them the build dies much later with an
 * `xcrun` or linker error that names nothing. `xcode-select -p` prints the developer directory when either
 * the tools or Xcode is installed.
 */
function xcodeToolsPresent(): boolean {
  const r = spawnSync("xcode-select", ["-p"], { stdio: "ignore" });
  return r.status === 0;
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
function run(cmd: string, args: string[]): ChildProcess {
  const child = windows
    ? spawn(process.execPath, [cmd, ...args], { cwd: root, stdio: "inherit", env })
    : spawn(cmd, args, { cwd: root, stdio: "inherit", env });
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

const vite = await viteThere(DEV_URL);
const firstBuild = !existsSync(join(root, "src-tauri", "target"));
const tauriArgs = hot ? ["dev", "--config", JSON.stringify({ build: { devUrl: DEV_URL } })] : ["dev", "--port", String(DEV_PORT)];
if (process.argv.includes("--check")) {
  const homeCargo = onPath("cargo", join(home, ".cargo", "bin"));
  const cargo = onPath("cargo") ?? (homeCargo ? homeCargo + " (not on PATH)" : null);
  console.log(cargo ? `rust: cargo at ${cargo}` : `rust: no cargo — \`${command}\` would stop and say how to install it`);
  if (mac)
    console.log(
      xcodeToolsPresent()
        ? "xcode: command line tools present"
        : `xcode: no command line tools — \`${command}\` would stop and say to run \`xcode-select --install\``,
    );
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
    console.log(
      vite === "none"
        ? `page: ${pageStale(root) ? "app/dist older than its sources — would build it" : "app/dist up to date"}, served at ${DEV_URL} by the Tauri CLI`
        : `page: something already answers at ${DEV_URL} — \`${command}\` would stop`,
    );
  }
  console.log(
    `tauri: would run ${bin("tauri")} ${tauriArgs.join(" ")} (beforeDevCommand bundles the mod)${firstBuild ? "; first build, compiles the shell" : ""}`,
  );
  console.log(
    `mod: ${(await answering(MOD_HEALTH)) ? "answering" : "not answering"} at ${MOD_HEALTH} — would wait up to ${MOD_WAIT_MS / 1000} s after the window starts the daemon`,
  );
  process.exit(0);
}

const path = rustPreflight();
if (!path) process.exit(1);
if (mac && !xcodeToolsPresent()) {
  console.error(
    [
      "loki dev: Xcode's command line tools are not installed (`xcode-select -p` finds no developer directory); cargo cannot link without them.",
      `  Run \`xcode-select --install\`, finish the dialog, then \`${command}\` again.`,
    ].join("\n"),
  );
  process.exit(1);
}
env = { ...process.env, PATH: path };
if (hot) delete env.LOKI_BUILT_PAGE;
else env.LOKI_BUILT_PAGE = "1";

if (vite === "other") {
  console.error(
    [
      `loki dev: something else is answering at ${DEV_URL} — another project's dev server, not loki's Vite (its page lacks loki's title).`,
      `  The window would show that page. Stop that server, or start it on another port, then \`${command}\` again.`,
    ].join("\n"),
  );
  process.exit(1);
}
if (!hot && vite === "ours") {
  console.error(
    [
      `loki dev: loki's page is already served at ${DEV_URL} — a Vite (\`npm run dev:vite\`) or another \`npm start\`.`,
      `  \`npm start\` serves the built page on that port itself: stop the other one, then \`npm start\` again.`,
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
  console.error(`loki dev: serving the built page at ${DEV_URL}; a change to it waits for update in the window`);
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

if (firstBuild) console.error("loki dev: first build — cargo compiles the shell once, a few minutes; later starts take seconds");
const tauri = run(bin("tauri"), tauriArgs);
tauri.on("exit", (code) => {
  stopAll();
  process.exit(code ?? 0);
});

if (hot) watchPhoneBuild();

function watchPhoneBuild(): void {
  console.error("loki dev: rebuilding the phone's app (app/dist) as the code changes");
  // A build watch reads its config once (Vite's dev server restarts on a config change; this does not), so a change to
  // app/vite.config.ts starts it afresh; a stale config once left every build failing while the watch looked alive.
  let phoneBuild: ChildProcess;
  let restarting = false;
  const startPhoneBuild = () => {
    phoneBuild = run(bin("vite"), ["build", "--watch", "--emptyOutDir=false", "--logLevel", "error", "--config", "app/vite.config.ts"]);
    phoneBuild.on("exit", (code) => {
      if (restarting) return;
      if (tauri.exitCode === null)
        console.error(`loki dev: the phone's build watch exited (${code ?? "signal"}); run \`npm run build:app\` after phone changes`);
    });
  };
  startPhoneBuild();
  let configTimer: ReturnType<typeof setTimeout> | null = null;
  watch(join(root, "app", "vite.config.ts"), () => {
    if (configTimer) clearTimeout(configTimer);
    configTimer = setTimeout(() => {
      if (tauri.exitCode !== null) return;
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
  const alive = () => tauri.exitCode === null;
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
