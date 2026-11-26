import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { forLibc, thisLibc } from "./native-binaries.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const root = here("..");
const out = here("../desktop/resources");

// Outside (Node): a package resolves to the nearest node_modules/<name> up from where `from` really is. pnpm puts a
// dependency's own dependencies beside it in its store, not at the top of node_modules, so a fixed path misses them.
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

// Outside (esbuild): `legalComments` keeps only `/*!` and `@license` comments, and agent-slack's MIT license asks that
// its notice go with every copy of the ported Slack files, so the notice rides in the bundle as a footer.
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

const codemode = packageDir("@earendil-works/pi-codemode", root);
const keyring = packageDir("@napi-rs/keyring", root);
const { optionalDependencies = {} } = JSON.parse(readFileSync(join(keyring, "package.json"), "utf8")) as {
  optionalDependencies?: Record<string, string>;
};
const binaries = forLibc(Object.keys(optionalDependencies), thisLibc()).flatMap((name) => {
  const dir = findPackageDir(name, keyring);
  return dir ? [{ name, dir }] : [];
});
const quickjs = packageDir("quickjs-wasi", codemode);
const appDist = here("../app/dist");
const hasApp = existsSync(`${appDist}/index.html`);

await Promise.all([
  build({
    entryPoints: [here("../mod/index.ts")],
    define: { "process.env.LOKI_VERSION": JSON.stringify(version) },
    outfile: `${out}/mod/loki-mod.mjs`,
    bundle: true,
    minify: true,
    keepNames: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["esbuild"],
    // Outside (esbuild): `ws` reaches Node's builtins with require(), and without a `require` in scope esbuild's ESM
    // shim throws "Dynamic require of \"events\" is not supported" the moment Node imports the bundle.
    banner: { js: 'import { createRequire as __lokiCreateRequire } from "node:module"; const require = __lokiCreateRequire(import.meta.url);' },
    footer: { js: agentSlackNotice },
    legalComments: "none",
    logLevel: "warning",
  }),
  build({
    entryPoints: [here("../daemon/main.ts")],
    define: { "process.env.LOKI_VERSION": JSON.stringify(version) },
    outfile: `${out}/daemon/daemon.mjs`,
    bundle: true,
    minify: true,
    keepNames: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // Outside (esbuild): it cannot bundle the keychain binding's native code, which ships beside the daemon.
    external: ["esbuild", "@napi-rs/keyring"],
    banner: { js: 'import { createRequire as __lokiCreateRequire } from "node:module"; const require = __lokiCreateRequire(import.meta.url);' },
    legalComments: "none",
    logLevel: "warning",
  }),
  // Outside (pi-codemode): it finds its worker thread beside its own module, which bundling moves, and looks for the
  // QuickJS wasm in node_modules/quickjs-wasi beside the daemon, with the package file whose exports name it.
  build({
    entryPoints: [join(codemode, "dist/runtime/worker.js")],
    outfile: `${out}/daemon/codemode-worker.mjs`,
    bundle: true,
    minify: true,
    keepNames: true,
    platform: "node",
    format: "esm",
    target: "node22",
    legalComments: "none",
    logLevel: "warning",
  }),
]);

for (const { name, dir } of [{ name: "@napi-rs/keyring", dir: keyring }, ...binaries]) {
  cpSync(dir, `${out}/daemon/node_modules/${name}`, { recursive: true, dereference: true });
}
for (const file of ["package.json", "quickjs.wasm"]) cpSync(join(quickjs, file), `${out}/daemon/node_modules/quickjs-wasi/${file}`);
cpSync(here("../skills/loki"), `${out}/skills/loki`, { recursive: true });

if (hasApp) {
  cpSync(appDist, `${out}/app`, { recursive: true });
}
const stamp = createHash("sha256")
  .update(version)
  .update(readFileSync(`${out}/mod/loki-mod.mjs`))
  .update(readFileSync(`${out}/daemon/daemon.mjs`))
  .update(readFileSync(`${out}/daemon/codemode-worker.mjs`));
if (hasApp) stamp.update(readFileSync(`${out}/app/index.html`));
writeFileSync(`${out}/.bundle-stamp`, `${stamp.digest("hex")}\n`);

if (hasApp) {
  console.log("mod bundled → desktop/resources/ (with app/dist for phones)");
} else {
  console.log("mod bundled → desktop/resources/");
  console.log("note: app/dist not found — phones get a 'run bun run build:app' page until the canvas is built and build:mod runs again");
}
