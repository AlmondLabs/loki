// Bundle loki's daemon and the mod it hosts into the files the loki app installs: src-tauri/resources/daemon/daemon.mjs
// and src-tauri/resources/mod/loki-mod.mjs (plus the agent's skill, and the built canvas for phones when app/dist exists).
// `npm run build:mod`; tauri runs it before dev and build.
// node_modules are bundled in (ws), except esbuild, which the mod treats as optional.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const out = here("../src-tauri/resources");
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/mod`, { recursive: true });

const { version } = JSON.parse(readFileSync(here("../package.json"), "utf8")) as { version: string };

await build({
  entryPoints: [here("../mod/index.ts")],
  // The bundle knows its version (analytics stamps it on every event); a checkout reads package.json instead.
  define: { "process.env.LOKI_VERSION": JSON.stringify(version) },
  outfile: `${out}/mod/loki-mod.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["esbuild"],
  // The bundle is ESM, and `ws` (inlined) reaches Node's builtins with require(): without a `require` in scope,
  // esbuild's shim throws "Dynamic require of \"events\" is not supported" the moment Node imports the bundle,
  // and the mod never activates.
  banner: { js: 'import { createRequire as __lokiCreateRequire } from "node:module"; const require = __lokiCreateRequire(import.meta.url);' },
  legalComments: "none",
  logLevel: "warning",
});
// loki's daemon (plan 017), which the shell starts and keeps running: the same banner, and pi-durable's SQLite
// backend is Node's own `node:sqlite`, which stays a builtin.
await build({
  entryPoints: [here("../daemon/main.ts")],
  define: { "process.env.LOKI_VERSION": JSON.stringify(version) },
  outfile: `${out}/daemon/daemon.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // The keychain binding is native code esbuild cannot bundle: it ships beside the daemon, below.
  external: ["esbuild", "@napi-rs/keyring"],
  banner: { js: 'import { createRequire as __lokiCreateRequire } from "node:module"; const require = __lokiCreateRequire(import.meta.url);' },
  legalComments: "none",
  logLevel: "warning",
});
// The keychain binding and this system's prebuilt binary (@napi-rs/keyring-<platform>), where Node finds them from
// daemon.mjs: <data>/daemon/node_modules. Each release runner builds its own system's.
for (const pkg of readdirSync(here("../node_modules/@napi-rs")).filter((p) => p === "keyring" || p.startsWith("keyring-"))) {
  cpSync(here(`../node_modules/@napi-rs/${pkg}`), `${out}/daemon/node_modules/@napi-rs/${pkg}`, { recursive: true, dereference: true });
}
cpSync(here("../skills/loki"), `${out}/skills/loki`, { recursive: true });

// The canvas the LAN listener serves to phones (mod/static.ts); install.rs puts it at <data>/app beside the mod.
const appDist = here("../app/dist");
if (existsSync(`${appDist}/index.html`)) {
  cpSync(appDist, `${out}/app`, { recursive: true });
  console.log("mod bundled → src-tauri/resources/ (with app/dist for phones)");
} else {
  console.log("mod bundled → src-tauri/resources/");
  console.log("note: app/dist not found — phones get a 'run npm run build:app' page until the canvas is built and build:mod runs again");
}
