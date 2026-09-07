// Bundle the mod into the single file the loki app installs: src-tauri/resources/mod/loki-mod.mjs
// (plus the agent's skill). `bun run build:mod`; tauri runs it before dev and build.
// node_modules are bundled in (ws), except esbuild, which the mod treats as optional.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
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
console.log("mod bundled → src-tauri/resources/");
