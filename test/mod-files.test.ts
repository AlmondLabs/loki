import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModFolder } from "../daemon/mods/files.ts";
import { ModRegistry } from "../daemon/mods/registry.ts";

/** Reloading on edit runs under Node, the daemon's runtime: test-node/mod-files.node-test.ts. */
describe("mods from a folder", () => {
  test("a file without a mod in it is reported and loads nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-mods-"));
    writeFileSync(join(dir, "broken.mjs"), "export const nothing = 1;\n");
    const reports: string[] = [];
    const mods = new ModRegistry(() => {});
    const stop = await loadModFolder(mods, dir, (m) => reports.push(m));
    try {
      expect(mods.names()).toEqual([]);
      expect(reports[0]).toContain("broken.mjs");
    } finally {
      stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
