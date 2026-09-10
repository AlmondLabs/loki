// Bundle the mod into the single file the loki app installs: src-tauri/resources/mod/loki-mod.mjs
// (plus the agent's skill, and the built canvas for phones when app/dist exists).
// `bun run build:mod`; tauri runs it before dev and build.
// node_modules are bundled in (ws), except esbuild, which the mod treats as optional.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const out = here("../src-tauri/resources");
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/mod`, { recursive: true });

await build({
  entryPoints: [here("../mod/mod.ts")],
  outfile: `${out}/mod/loki-mod.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["esbuild"],
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
