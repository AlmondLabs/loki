import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

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
    expect(src.match(/banner:\s*\{\s*js:\s*'import \{ createRequire as \w+ \} from "node:module"; const require = \w+\(import\.meta\.url\);'/g)).toHaveLength(2);
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
