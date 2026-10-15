import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The release bundle (src-tauri/resources/mod/loki-mod.mjs) is what every Homebrew and .dmg install runs; a
 * checkout runs mod/boot.ts instead, so a bundle that does not import under Node goes unnoticed for weeks
 * (found 2026-09-15, docs/plans/…-009).
 */
describe("the release bundle's build", () => {
  const src = readFileSync(new URL("../scripts/build-mod.ts", import.meta.url), "utf8");

  test("gives the ESM bundle a `require`, or the inlined ws throws on Node's first import", () => {
    expect(src).toContain('format: "esm"');
    expect(src).toMatch(/banner:\s*\{\s*js:\s*'import \{ createRequire as \w+ \} from "node:module"; const require = \w+\(import\.meta\.url\);'/);
  });

  test("the daemon is bundled beside the mod, for Node, with the same `require` banner (plan 017)", () => {
    expect(src).toContain('entryPoints: [here("../daemon/main.ts")]');
    expect(src).toContain("outfile: `${out}/daemon/daemon.mjs`");
    expect(src.match(/banner:\s*\{\s*js:\s*'import \{ createRequire as \w+ \} from "node:module"; const require = \w+\(import\.meta\.url\);'/g)).toHaveLength(
      2,
    );
  });

  test("the mod takes ws from one module, the package esbuild inlines", () => {
    const ws = readFileSync(new URL("../mod/ws.ts", import.meta.url), "utf8");
    expect(ws).toContain('export { WebSocket, WebSocketServer } from "ws";');
    // and nothing else in the mod reaches for the package directly
    for (const f of readdirSync(new URL("../mod/", import.meta.url)).filter((n) => n.endsWith(".ts") && n !== "ws.ts")) {
      expect(readFileSync(new URL(`../mod/${f}`, import.meta.url), "utf8"), f).not.toMatch(/from "ws"/);
    }
    expect(readFileSync(new URL("../mod/server.ts", import.meta.url), "utf8")).toContain('from "./ws.ts"');
  });
});

/**
 * pi-ai loads each sign-in flow through a variable path so a bundler cannot follow it; bundled into daemon.mjs, that
 * path pointed beside the bundle at files that are not there, and every release build's sign-in failed with "Cannot
 * find module …/openai-chatgpt.js" (2026.1011.1). The daemon registers the flows statically (daemon/main.ts); this
 * bundles the same way the release does, runs the bundle from a folder of its own, and asks for the ChatGPT flow.
 */
describe("sign-in flows in a bundle", () => {
  test("load from a bundle once registered, as daemon/main.ts does before anything asks", async () => {
    const { build } = await import("esbuild");
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { pathToFileURL } = await import("node:url");
    expect(readFileSync(new URL("../daemon/main.ts", import.meta.url), "utf8")).toMatch(/registerBunOAuthFlows\(\);\s*const models = builtinModels/);
    const dir = mkdtempSync(join(tmpdir(), "loki-oauth-bundle-"));
    try {
      const entry = join(dir, "entry.ts");
      // the loader the providers call is internal to pi-ai: imported by its file, the one the helper registers into
      const loader = join(import.meta.dirname, "..", "node_modules", "@earendil-works", "pi-ai", "dist", "auth", "oauth", "load.js");
      writeFileSync(
        entry,
        `import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";\nimport { loadOpenAIChatGPTOAuth } from ${JSON.stringify(loader)};\nregisterBunOAuthFlows();\nexport const flow = await loadOpenAIChatGPTOAuth();\n`,
      );
      const outfile = join(dir, "out", "bundle.mjs");
      await build({
        entryPoints: [entry],
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        outfile,
        nodePaths: [join(import.meta.dirname, "..", "node_modules")],
        banner: { js: 'import { createRequire as __r } from "node:module"; const require = __r(import.meta.url);' },
        logLevel: "silent",
      });
      const mod = (await import(pathToFileURL(outfile).href)) as { flow: unknown };
      expect(mod.flow).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
