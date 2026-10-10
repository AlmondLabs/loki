import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeskRegistry } from "../mod/desks.ts";

describe("desk registry", () => {
  test("remembers, persists, reloads; scope is the sanitized conversation id", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-desks-"));
    try {
      const path = join(dir, "desks.json");
      const reg = new DeskRegistry(path, () => null);
      expect(reg.remember("local-conv-1", "agent-1")).toBe("local-conv-1");
      expect(reg.get("local-conv-1")).toEqual({ agent_id: "agent-1", conversation_id: "local-conv-1" });
      // unknown agent and no local backend entry: scope still returned, nothing stored
      expect(reg.remember("conv-x", null)).toBe("conv-x");
      expect(reg.get("conv-x")).toBeUndefined();
      const again = new DeskRegistry(path, () => null);
      expect(again.get("local-conv-1")).toEqual({ agent_id: "agent-1", conversation_id: "local-conv-1" });
      expect(again.all()).toEqual([{ scope: "local-conv-1", agent_id: "agent-1", conversation_id: "local-conv-1" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("forgetAgent drops every desk of one agent and persists", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-desks-"));
    try {
      const reg = new DeskRegistry(join(dir, "desks.json"), () => null);
      reg.remember("default", "agent-helper");
      reg.remember("local-conv-1", "agent-helper");
      reg.remember("local-conv-2", "agent-9");
      expect(reg.forgetAgent("agent-helper")).toBe(2);
      expect(reg.forgetAgent("agent-helper")).toBe(0);
      expect(new DeskRegistry(join(dir, "desks.json"), () => null).all().map((d) => d.agent_id)).toEqual(["agent-9"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

});

describe("desk registry fallback", () => {
  test("resolves desks it never saw: main chats from the scope, others from whoever knows the chat's agent", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-desks-"));
    try {
      const reg = new DeskRegistry(join(dir, "desks.json"), (id) => (id === "local-conv-77" ? "agent-z" : null));
      expect(reg.get("default-agent-q")).toEqual({ agent_id: "agent-q", conversation_id: "default" });
      expect(reg.get("local-conv-77")).toEqual({ agent_id: "agent-z", conversation_id: "local-conv-77" });
      expect(reg.get("local-conv-unknown")).toBeUndefined();
      expect(reg.get("shared")).toBeUndefined();
      // resolved desks are cached to disk like any other
      const again = new DeskRegistry(join(dir, "desks.json"), () => null);
      expect(again.get("default-agent-q")).toEqual({ agent_id: "agent-q", conversation_id: "default" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("DeskRegistry: one scope per conversation", () => {
  test("a legacy bare 'default' key folds onto default-<agentId> and is rewritten on disk", async () => {
    const { mkdtempSync, writeFileSync: w, readFileSync: r, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: j } = await import("node:path");
    const { DeskRegistry } = await import("../mod/desks.ts");
    const dir = mkdtempSync(j(tmpdir(), "loki-registry-"));
    const file = j(dir, "desks.json");
    w(file, JSON.stringify({ default: { agent_id: "agent-1", conversation_id: "default" }, "default-agent-1": { agent_id: "agent-1", conversation_id: "default" }, "local-conv-9": { agent_id: "agent-1", conversation_id: "local-conv-9" } }));
    const reg = new DeskRegistry(file, () => null);
    expect(reg.all().map((d) => d.scope).sort()).toEqual(["default-agent-1", "local-conv-9"]);
    expect(Object.keys(JSON.parse(r(file, "utf8"))).sort()).toEqual(["default-agent-1", "local-conv-9"]);
    rmSync(dir, { recursive: true, force: true });
  });
});
