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
  footer: { js: agentSlackNotice },
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
