import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFolder, completeFolder, expandPath, gitBranch, recentFolders } from "../mod/folders.ts";
import { conversationDirName } from "../core/desk-core.ts";

describe("folders", () => {
  test("recent folders per agent, newest first, deduped; the desk's own folder by conversation", () => {
    const backend = mkdtempSync(join(tmpdir(), "loki-backend-"));
    try {
      const conv = (id: string, agent: string, at: string, cwd: string) => {
        const d = join(backend, "conversations", conversationDirName(id));
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, "conversation.json"), JSON.stringify({ id, agent_id: agent, last_message_at: at }));
        writeFileSync(join(d, "messages.jsonl"), JSON.stringify({ type: "session", id, cwd }) + "\n" + JSON.stringify({ type: "message" }) + "\n");
      };
      conv("c1", "a1", "2026-09-01T00:00:00Z", "/work/old");
      conv("c2", "a1", "2026-09-03T00:00:00Z", "/work/new");
      conv("c3", "a1", "2026-09-02T00:00:00Z", "/work/new");
      conv("c4", "a2", "2026-09-02T00:00:00Z", "/home/x");
      const r = recentFolders(backend);
      expect(r.byAgent).toEqual({ a1: ["/work/new", "/work/old"], a2: ["/home/x"] });
      expect(r.byConversation[conversationDirName("c4")]).toBe("/home/x");
    } finally {
      rmSync(backend, { recursive: true, force: true });
    }
  });

  test("expand, complete, check and branch", () => {
    const home = mkdtempSync(join(tmpdir(), "loki-home-"));
    try {
      mkdirSync(join(home, "proj", "alpha", ".git"), { recursive: true });
      mkdirSync(join(home, "proj", "beta"), { recursive: true });
      mkdirSync(join(home, "proj", ".hidden"), { recursive: true });
      writeFileSync(join(home, "proj", "alpha", ".git", "HEAD"), "ref: refs/heads/feature/x\n");
      writeFileSync(join(home, "proj", "note.txt"), "");
      expect(expandPath("~/proj", home)).toBe(join(home, "proj"));
      expect(completeFolder("~/proj/", home)).toEqual([join(home, "proj", "alpha"), join(home, "proj", "beta")]);
      expect(completeFolder("~/proj/al", home)).toEqual([join(home, "proj", "alpha")]);
      expect(completeFolder("relative/path", home)).toEqual([]);
      expect(checkFolder("~/proj/alpha", home)).toEqual({ ok: true, path: join(home, "proj", "alpha"), branch: "feature/x" });
      expect(checkFolder("~/proj/alpha/sub", home).reason).toBe("no such folder");
      expect(checkFolder("~/proj/note.txt", home).reason).toBe("not a folder");
      expect(gitBranch(join(home, "proj", "beta"))).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
