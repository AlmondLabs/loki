import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { forLibc, thisLibc } from "./native-binaries.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const root = here("..");
const out = here("../src-tauri/resources");

// A package's folder as Node finds it from `from` (the checkout, or another package's folder): the nearest
// node_modules/<name> up from where `from` really is. bun and npm put a dependency's own dependencies at the top of
// node_modules and pnpm puts them beside it in its store, so a fixed node_modules/<name> path holds them under the first two alone.
const findPackageDir = (name: string, from: string): string | undefined => {
  for (let dir = realpathSync(from); ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
};
const packageDir = (name: string, from: string): string => {
  const dir = findPackageDir(name, from);
  if (!dir) throw new Error(`build:mod: ${name} is not installed (looked up from ${from}); run the install again`);
  return dir;
};
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/mod`, { recursive: true });

const { version } = JSON.parse(readFileSync(here("../package.json"), "utf8")) as { version: string };

// loki's Slack session reader and client (mod/slack-session.ts, mod/slack-leveldb.ts, mod/slack.ts) are ported from
// agent-slack, whose MIT license asks that its notice go with every copy. `legalComments` keeps only `/*!` and
// `@license` comments, which the ported files' line comments are not, and the installer copies loki-mod.mjs alone, so
// the notice rides in the bundle itself.
const agentSlackNotice = `/*!
 * loki's Slack session reader and client are ported from agent-slack (https://github.com/stablyai/agent-slack).
 *
 * MIT License. Copyright (c) 2026 Stably. Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following
 * conditions: The above copyright notice and this permission notice shall be included in all copies or substantial
 * portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
 */`;

await build({
  entryPoints: [here("../mod/index.ts")],
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
  footer: { js: agentSlackNotice },
  legalComments: "none",
  logLevel: "warning",
});
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
const keyring = packageDir("@napi-rs/keyring", root);
const { optionalDependencies = {} } = JSON.parse(readFileSync(join(keyring, "package.json"), "utf8")) as {
  optionalDependencies?: Record<string, string>;
};
const binaries = forLibc(Object.keys(optionalDependencies), thisLibc()).flatMap((name) => {
  const dir = findPackageDir(name, keyring);
  return dir ? [{ name, dir }] : [];
});
for (const { name, dir } of [{ name: "@napi-rs/keyring", dir: keyring }, ...binaries]) {
  cpSync(dir, `${out}/daemon/node_modules/${name}`, { recursive: true, dereference: true });
}
// The script sandbox's worker thread (daemon/scripts.ts): its own entry, because the package finds its worker beside
// its own module, which bundling moves. The QuickJS wasm it compiles goes where the package looks for it,
// <data>/daemon/node_modules/quickjs-wasi, with the package file whose exports name it.
const codemode = packageDir("@earendil-works/pi-codemode", root);
await build({
  entryPoints: [join(codemode, "dist/runtime/worker.js")],
  outfile: `${out}/daemon/codemode-worker.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "none",
  logLevel: "warning",
});
const quickjs = packageDir("quickjs-wasi", codemode);
for (const file of ["package.json", "quickjs.wasm"]) cpSync(join(quickjs, file), `${out}/daemon/node_modules/quickjs-wasi/${file}`);
cpSync(here("../skills/loki"), `${out}/skills/loki`, { recursive: true });

const appDist = here("../app/dist");
if (existsSync(`${appDist}/index.html`)) {
  cpSync(appDist, `${out}/app`, { recursive: true });
  console.log("mod bundled → src-tauri/resources/ (with app/dist for phones)");
} else {
  console.log("mod bundled → src-tauri/resources/");
  console.log("note: app/dist not found — phones get a 'run bun run build:app' page until the canvas is built and build:mod runs again");
}
