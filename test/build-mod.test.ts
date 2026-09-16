import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The release bundle (src-tauri/resources/mod/loki-mod.mjs) is what every Homebrew and .dmg install runs; a
 * checkout runs mod/boot.ts instead, so a bundle that only imports under Bun goes unnoticed for weeks. Two
 * things keep it importable under Node and working under Bun (found 2026-09-15, docs/plans/…-009).
 */
describe("the release bundle's build", () => {
  const src = readFileSync(new URL("../scripts/build-mod.ts", import.meta.url), "utf8");

  test("gives the ESM bundle a `require`, or the inlined ws throws on Node's first import", () => {
    expect(src).toContain('format: "esm"');
    expect(src).toMatch(/banner:\s*\{\s*js:\s*'import \{ createRequire as \w+ \} from "node:module"; const require = \w+\(import\.meta\.url\);'/);
  });

  test("the mod takes Bun's own ws at runtime rather than the inlined copy", () => {
    const ws = readFileSync(new URL("../mod/ws.ts", import.meta.url), "utf8");
    expect(ws).toContain("process.versions.bun");
    expect(ws).toContain('const specifier = process.env.LOKI_WS_MODULE ?? "ws"'); // opaque to esbuild, which folds "w" + "s"
    expect(ws).toContain("await import(specifier)");
    for (const f of ["app-server.ts", "recall-worker.ts", "server.ts"]) {
      expect(readFileSync(new URL(`../mod/${f}`, import.meta.url), "utf8")).toContain('from "./ws.ts"');
    }
  });
});
