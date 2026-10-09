/**
 * Plan 017, U4: mods in a folder load, reload when edited, and unload when removed. Runs under Node, the daemon's
 * runtime: `bun run test:node`.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadModFolder } from "../daemon/mods/files.ts";
import { ModRegistry } from "../daemon/mods/registry.ts";

const modSource = (description: string) =>
  `export default { name: "folder-mod", apiVersion: 1, activate(api) { api.tools.register({ name: "hello", description: ${JSON.stringify(description)}, parameters: { type: "object", properties: {} }, execute: () => "hi" }); } };\n`;

const descriptions = (mods: ModRegistry) => mods.registry.snapshot().tools().map((t) => t.tool.description);

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
}

test("a mod file is loaded, loaded again when it changes, and unloaded when it is removed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loki-mods-"));
  const mods = new ModRegistry(() => {});
  const stop = await loadModFolder(mods, dir, () => {});
  try {
    writeFileSync(join(dir, "hello.mjs"), modSource("first"));
    await until(() => descriptions(mods).includes("first"));
    assert.deepEqual(mods.names(), ["folder-mod"]);
    writeFileSync(join(dir, "hello.mjs"), modSource("second"));
    await until(() => descriptions(mods).includes("second"));
    assert.deepEqual(descriptions(mods), ["second"]);
    unlinkSync(join(dir, "hello.mjs"));
    await until(() => mods.names().length === 0);
    assert.deepEqual(descriptions(mods), []);
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
