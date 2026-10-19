import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMcp, isModPath, listModFiles, mcpSnapshot } from "../daemon/config-sync.ts";
import { applyFiles, filesSnapshot } from "../mod/recall-sync.ts";

const servers = (path: string) => (JSON.parse(readFileSync(path, "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers;

describe("MCP servers on two Macs", () => {
  test("a server added on one Mac appears on the other; removed later, it goes, and an older add does not revive it", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-config-sync-"));
    const book = { config: join(dir, "book.json"), manifest: join(dir, "book-sync.json") };
    const mini = { config: join(dir, "mini.json"), manifest: join(dir, "mini-sync.json") };
    try {
      writeFileSync(book.config, JSON.stringify({ mcpServers: { notion: { url: "https://mcp.notion.com/mcp" } }, note: "kept" }));
      expect(applyMcp(mini.config, mini.manifest, mcpSnapshot(book.config, book.manifest, "2026-10-18T10:00:00Z"), "2026-10-18T10:00:01Z")).toBe(true);
      expect(servers(mini.config)).toEqual({ notion: { url: "https://mcp.notion.com/mcp" } });
      // Removed on the MacBook later: the mini removes it too.
      writeFileSync(book.config, JSON.stringify({ mcpServers: {}, note: "kept" }));
      const removal = mcpSnapshot(book.config, book.manifest, "2026-10-18T11:00:00Z");
      expect(applyMcp(mini.config, mini.manifest, removal, "2026-10-18T11:00:01Z")).toBe(true);
      expect(servers(mini.config)).toEqual({});
      // The mini's older snapshot, from before the removal, does not bring it back to the MacBook.
      expect(
        applyMcp(book.config, book.manifest, { servers: { notion: { value: { url: "x" }, at: "2026-10-18T10:00:00Z" } }, removed: {} }, "2026-10-18T11:00:02Z"),
      ).toBe(false);
      expect((JSON.parse(readFileSync(book.config, "utf8")) as { note?: string }).note).toBe("kept");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an edit by hand counts as a change, and the later edit wins on both", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-config-sync-"));
    const book = { config: join(dir, "book.json"), manifest: join(dir, "book-sync.json") };
    const mini = { config: join(dir, "mini.json"), manifest: join(dir, "mini-sync.json") };
    try {
      writeFileSync(book.config, JSON.stringify({ mcpServers: { fs: { command: "fs-a" } } }));
      applyMcp(mini.config, mini.manifest, mcpSnapshot(book.config, book.manifest, "2026-10-18T10:00:00Z"), "2026-10-18T10:00:00Z");
      writeFileSync(mini.config, JSON.stringify({ mcpServers: { fs: { command: "fs-b" } } }));
      expect(applyMcp(book.config, book.manifest, mcpSnapshot(mini.config, mini.manifest, "2026-10-18T12:00:00Z"), "2026-10-18T12:00:01Z")).toBe(true);
      expect(servers(book.config)).toEqual({ fs: { command: "fs-b" } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mods on two Macs", () => {
  test("a mod file changed on one Mac is written on the other; node_modules and dotfiles stay", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-mods-sync-"));
    const which = { list: listModFiles, safe: isModPath };
    try {
      const book = join(dir, "book");
      const mini = join(dir, "mini");
      mkdirSync(join(book, "clock", "node_modules"), { recursive: true });
      writeFileSync(join(book, "clock", "index.mjs"), "export default {}");
      writeFileSync(join(book, "clock", "node_modules", "x.js"), "x");
      writeFileSync(join(book, ".secret"), "s");
      expect(applyFiles(mini, which, filesSnapshot(book, which))).toBe(true);
      expect(readFileSync(join(mini, "clock", "index.mjs"), "utf8")).toBe("export default {}");
      expect(existsSync(join(mini, "clock", "node_modules"))).toBe(false);
      expect(existsSync(join(mini, ".secret"))).toBe(false);
      expect(isModPath("../x.mjs")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
