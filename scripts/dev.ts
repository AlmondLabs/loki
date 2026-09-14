// One command for a development session: `bun start` (package.json "start").
//   0. Preflight: the Rust toolchain `tauri dev` needs (on PATH or where rustup puts it) and Xcode's command line
//      tools, which cargo links with.
//   1. Vite on 127.0.0.1:5173, unless loki's own Vite already answers there (a `bun run dev` in another terminal).
//      Another project's dev server on that port is refused rather than shown in the window.
//   2. `tauri dev` against it — its beforeDevCommand bundles the mod first — which opens the window.
//   3. A watch for the mod on its port: the window links to Letta's app-server on its own, but the desk needs the
//      mod inside the harness, and a harness that never loaded it shows only as Vite's proxy errors. One line says why.
// Ctrl-C (or the window closing) stops what this script started and nothing else. `--check` only reports.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DEV_URL = "http://127.0.0.1:5173";
/** In app/index.html; whatever answers on the port without it is not loki's Vite. */
const VITE_MARKER = 'name="apple-mobile-web-app-title" content="loki"';
const MOD_HEALTH = `http://127.0.0.1:${process.env.LOKI_PORT ?? "41414"}/health`;
const MOD_WAIT_MS = 90_000;
const root = fileURLToPath(new URL("..", import.meta.url));
const bin = (name: string) => fileURLToPath(new URL(`../node_modules/.bin/${name}`, import.meta.url));
const home = homedir();
const shimPath = join(home, ".letta", "mods", "loki.ts");
const harnessLog = join(home, ".letta", "loki", "logs", "harness.log");

/** Where `name` is, on PATH; null if nowhere. */
function onPath(name: string, path = process.env.PATH ?? ""): string | null {
  for (const dir of path.split(":")) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
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
  if (existsSync(join(cargoBin, "cargo"))) {
    console.error(`loki dev: cargo is at ${cargoBin} but not on PATH (a new terminal would have it) — using it for this run`);
    return `${cargoBin}:${path}`;
  }
  console.error(
    [
      "loki dev: the Tauri window is a Rust program and this Mac has no Rust toolchain (no `cargo` on PATH, none in ~/.cargo/bin).",
      "  Install it, then open a new terminal (or `source ~/.cargo/env`) and run `bun start` again:",
      "    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
      "  Building also needs Xcode's command line tools: `xcode-select --install` if clang is missing.",
      "  Without Rust, `bun run dev` serves the canvas alone at " + DEV_URL + " for a browser tab.",
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

/** What answers at the dev URL: loki's Vite, something else (another project's dev server), or nothing. */
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
  const child = spawn(cmd, args, { cwd: root, stdio: "inherit", env });
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
if (process.argv.includes("--check")) {
  const cargo = onPath("cargo") ?? (existsSync(join(home, ".cargo", "bin", "cargo")) ? join(home, ".cargo", "bin", "cargo") + " (not on PATH)" : null);
  console.log(cargo ? `rust: cargo at ${cargo}` : "rust: no cargo — `bun start` would stop and say how to install it");
  console.log(xcodeToolsPresent() ? "xcode: command line tools present" : "xcode: no command line tools — `bun start` would stop and say to run `xcode-select --install`");
  console.log(vite === "ours" ? `vite: loki's, already answering at ${DEV_URL} — would reuse it` : vite === "other" ? `vite: something else answers at ${DEV_URL} — \`bun start\` would stop` : `vite: not running — would start ${bin("vite")} --config app/vite.config.ts`);
  console.log(`tauri: would run ${bin("tauri")} dev --config {"build":{"devUrl":"${DEV_URL}"}} (beforeDevCommand bundles the mod)${firstBuild ? "; first build, compiles the shell" : ""}`);
  console.log(`mod: ${(await answering(MOD_HEALTH)) ? "answering" : "not answering"} at ${MOD_HEALTH} — would wait up to ${MOD_WAIT_MS / 1000} s after the window starts; shim ${existsSync(shimPath) ? "present" : "absent"} at ${shimPath}`);
  process.exit(0);
}

const path = rustPreflight();
if (!path) process.exit(1);
if (!xcodeToolsPresent()) {
  console.error(["loki dev: Xcode's command line tools are not installed (`xcode-select -p` finds no developer directory); cargo cannot link without them.", "  Run `xcode-select --install`, finish the dialog, then `bun start` again."].join("\n"));
  process.exit(1);
}
env = { ...process.env, PATH: path };

if (vite === "other") {
  console.error([`loki dev: something else is answering at ${DEV_URL} — another project's dev server, not loki's Vite (its page lacks loki's title).`, "  The window would show that page. Stop that server, or start it on another port, then `bun start` again."].join("\n"));
  process.exit(1);
}
if (vite === "ours") {
  console.error(`loki dev: loki's Vite is already answering at ${DEV_URL} — using it`);
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

if (firstBuild) console.error("loki dev: first build — cargo compiles the shell once, a few minutes; later starts take seconds");
const tauri = run(bin("tauri"), ["dev", "--config", JSON.stringify({ build: { devUrl: DEV_URL } })]);
tauri.on("exit", (code) => {
  stopAll(); // Vite too, if this script started it; a Vite from another terminal is not ours to stop
  process.exit(code ?? 0);
});

// The mod, once the harness has it. Nothing to say while it comes up; one paragraph if it never does.
void (async () => {
  const modUp = await waitFor(MOD_HEALTH, MOD_WAIT_MS, () => tauri.exitCode === null);
  if (modUp || tauri.exitCode !== null) return;
  console.error(
    [
      `loki dev: the mod is not answering at ${MOD_HEALTH} after ${MOD_WAIT_MS / 1000} s, so the desk has nothing to link to`,
      "  (Vite's \"ws proxy error\" lines above are that). The mod runs inside the Letta harness; the harness loads it from the shim",
      `  ${shimPath}${existsSync(shimPath) ? "" : " — which is missing; a dev build writes one pointing at this checkout when the shim is absent, so check the app's own output above"}.`,
      `  The harness's own log: ${harnessLog}. If Letta Code is still installing (first launch), the window's Welcome shows the progress.`,
    ].join("\n"),
  );
})();
