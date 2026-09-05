import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeskRegistry, lookupLocalAgentId, lookupLocalConversation, readLocalTranscript } from "../mod/desks.ts";
import { conversationDirName } from "../shared/desk-core.ts";

describe("desk registry", () => {
  test("remembers, persists, reloads; scope is the sanitized conversation id", () => {
    const dir = mkdtempSync(join(tmpdir(), "loci-desks-"));
    try {
      const path = join(dir, "desks.json");
      const reg = new DeskRegistry(path);
      expect(reg.remember("local-conv-1", "agent-1")).toBe("local-conv-1");
      expect(reg.get("local-conv-1")).toEqual({ agent_id: "agent-1", conversation_id: "local-conv-1" });
      // unknown agent and no local backend entry: scope still returned, nothing stored
      expect(reg.remember("conv-x", null)).toBe("conv-x");
      expect(reg.get("conv-x")).toBeUndefined();
      const again = new DeskRegistry(path);
      expect(again.get("local-conv-1")).toEqual({ agent_id: "agent-1", conversation_id: "local-conv-1" });
      expect(again.all()).toEqual([{ scope: "local-conv-1", agent_id: "agent-1", conversation_id: "local-conv-1" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("lookupLocalAgentId reads the local backend's conversation.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "loci-backend-"));
    try {
      const convDir = join(dir, "conversations", Buffer.from("conversation:local-conv-9").toString("base64").replace(/=+$/, ""));
      mkdirSync(convDir, { recursive: true });
      writeFileSync(join(convDir, "conversation.json"), JSON.stringify({ id: "local-conv-9", agent_id: "agent-9", summary: "[Short] - Trip planning", last_message_at: "2026-09-03T05:00:00.000Z" }));
      expect(lookupLocalAgentId("local-conv-9", dir)).toBe("agent-9");
      expect(lookupLocalConversation("local-conv-9", null, dir)).toEqual({ agentId: "agent-9", title: "[Short] - Trip planning", lastMessageAt: "2026-09-03T05:00:00.000Z", archived: false });
      writeFileSync(join(convDir, "conversation.json"), JSON.stringify({ id: "local-conv-9", agent_id: "agent-9", summary: "x", archived: true, archived_at: "2026-09-03T06:00:00.000Z" }));
      expect(lookupLocalConversation("local-conv-9", null, dir)?.archived).toBe(true);
      expect(lookupLocalConversation("nope", null, dir)).toBeNull();
      // an agent's main chat lives under default:<agentId>
      const defDir = join(dir, "conversations", Buffer.from("default:agent-9").toString("base64").replace(/=+$/, ""));
      mkdirSync(defDir, { recursive: true });
      mkdirSync(join(dir, "agents"), { recursive: true });
      writeFileSync(join(dir, "agents", `${Buffer.from("agent-9").toString("base64").replace(/=+$/, "")}.json`), JSON.stringify({ name: "friday" }));
      writeFileSync(join(defDir, "conversation.json"), JSON.stringify({ id: "default", agent_id: "agent-9", summary: null, archived: false }));
      expect(lookupLocalConversation("default", "agent-9", dir)?.title).toBe("friday · main chat");
      expect(lookupLocalConversation("default", null, dir)).toBeNull();
      expect(lookupLocalAgentId("nope", dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("local transcript", () => {
  test("keeps user/assistant text across compactions, marks tool calls, drops tool results and harness markup", () => {
    const backend = mkdtempSync(join(tmpdir(), "loci-backend-"));
    try {
      const dir = join(backend, "conversations", conversationDirName("local-conv-9"));
      mkdirSync(dir, { recursive: true });
      const lines = [
        { type: "session", id: "local-conv-9" },
        { type: "message", message: { role: "user", content: [{ type: "text", text: "<system-reminder>env</system-reminder>\nhello there" }] } },
        { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "toolCall", id: "t1", name: "Bash", arguments: {} }] } },
        { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } },
        { type: "compaction", summary: "…" },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "done." }] } },
        "not json",
        { type: "message", message: { role: "user", content: "plain string" } },
      ];
      writeFileSync(join(dir, "messages.jsonl"), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
      expect(readLocalTranscript("local-conv-9", null, 400, backend)).toEqual([
        { role: "user", text: "hello there" },
        { role: "tool", text: "Bash" },
        { role: "assistant", text: "done." },
        { role: "user", text: "plain string" },
      ]);
      expect(readLocalTranscript("local-conv-9", null, 2, backend).map((m) => m.text)).toEqual(["done.", "plain string"]);
      expect(readLocalTranscript("missing", null, 400, backend)).toEqual([]);
    } finally {
      rmSync(backend, { recursive: true, force: true });
    }
  });
});

describe("desk registry fallback", () => {
  test("resolves desks it never saw: main chats from the scope, others from the local backend", () => {
    const dir = mkdtempSync(join(tmpdir(), "loci-desks-"));
    try {
      const conv = join(dir, "backend", "conversations", conversationDirName("local-conv-77"));
      mkdirSync(conv, { recursive: true });
      writeFileSync(join(conv, "conversation.json"), JSON.stringify({ id: "local-conv-77", agent_id: "agent-z" }));
      const reg = new DeskRegistry(join(dir, "desks.json"), join(dir, "backend"));
      expect(reg.get("default-agent-q")).toEqual({ agent_id: "agent-q", conversation_id: "default" });
      expect(reg.get("local-conv-77")).toEqual({ agent_id: "agent-z", conversation_id: "local-conv-77" });
      expect(reg.get("local-conv-unknown")).toBeUndefined();
      expect(reg.get("shared")).toBeUndefined();
      // resolved desks are cached to disk like any other
      const again = new DeskRegistry(join(dir, "desks.json"), join(dir, "backend"));
      expect(again.get("default-agent-q")).toEqual({ agent_id: "agent-q", conversation_id: "default" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
