// Bundle the mod into the single file the loki app installs: src-tauri/resources/mod/loki-mod.mjs
// (plus the agent's skill, and the built canvas for phones when app/dist exists).
// `bun run build:mod`; tauri runs it before dev and build.
// node_modules are bundled in (ws), except esbuild, which the mod treats as optional.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
  target: "node20",
  external: ["esbuild"],
  // The bundle is ESM, and `ws` (inlined) reaches Node's builtins with require(): without a `require` in scope,
  // esbuild's shim throws "Dynamic require of \"events\" is not supported" the moment Node imports the bundle,
  // and the mod never activates. Bun tolerated it, which is how it went unnoticed.
  banner: { js: 'import { createRequire as __lokiCreateRequire } from "node:module"; const require = __lokiCreateRequire(import.meta.url);' },
  legalComments: "none",
  logLevel: "warning",
});
cpSync(here("../skills/loki"), `${out}/skills/loki`, { recursive: true });

// The canvas the LAN listener serves to phones (mod/static.ts); install.rs puts it at <data>/app beside the mod.
const appDist = here("../app/dist");
if (existsSync(`${appDist}/index.html`)) {
  cpSync(appDist, `${out}/app`, { recursive: true });
  console.log("mod bundled → src-tauri/resources/ (with app/dist for phones)");
} else {
  console.log("mod bundled → src-tauri/resources/");
  console.log("note: app/dist not found — phones get a 'run bun run build:app' page until the canvas is built and build:mod runs again");
}
