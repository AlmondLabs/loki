import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");

/** Mod bundle: self-contained (ws bundled in) so the ~/.letta/mods shim
 *  needs zero dependency resolution. Runs inside Letta Code's Node. */
const modConfig = {
  entryPoints: ["src/mod.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/mod.js",
  sourcemap: true,
  logLevel: "info",
  // ws is CJS; give the ESM bundle a real require() for node builtins.
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
};

/** Web bundle: the canvas page. */
const webConfig = {
  entryPoints: ["web/main.tsx"],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  outdir: "dist/web/assets",
  sourcemap: true,
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
};

function copyStatic() {
  mkdirSync("dist/web", { recursive: true });
  cpSync("web/index.html", "dist/web/index.html");
  // Vendor shims are served as-is (import-map targets), not bundled.
  cpSync("web/vendor-shims", "dist/web/vendor-shims", { recursive: true });
}

if (watch) {
  const modCtx = await esbuild.context(modConfig);
  const webCtx = await esbuild.context(webConfig);
  copyStatic();
  await Promise.all([modCtx.watch(), webCtx.watch()]);
  console.log("watching…");
} else {
  await Promise.all([esbuild.build(modConfig), esbuild.build(webConfig)]);
  copyStatic();
}
