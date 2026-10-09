import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lettaLogCwd, lettaLogEntries } from "../daemon/import/convert.ts";
import { entrySteps } from "../core/attention/pi-steps.ts";
import { foldSteps } from "../core/attention/thread.ts";
import { readLocalTranscriptPage } from "../mod/desks.ts";
import { conversationDirName } from "../core/desk-core.ts";
import { assistantLine, headerLine, logText, sampleLog, userLine } from "./fixtures/letta-log.ts";

/** The rows the mod shows today for a log on disk. */
function rowsFromDisk(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "loki-convert-"));
  try {
    const conv = join(dir, "conversations", conversationDirName("local-conv-test", "agent-local-test"));
    mkdirSync(conv, { recursive: true });
    writeFileSync(join(conv, "messages.jsonl"), text);
    return readLocalTranscriptPage("local-conv-test", "agent-local-test", 1000, dir).rows;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Letta log conversion", () => {
  test("a converted log folds into the same rows the mod shows from the log itself", () => {
    const text = sampleLog();
    const converted = lettaLogEntries(text);
    expect(foldSteps(converted.flatMap(entrySteps))).toEqual(rowsFromDisk(text));
  });

  test("entries keep their order and kinds; the compaction heads the entry it keeps, wrapped as pi-durable wraps it", () => {
    const converted = lettaLogEntries(sampleLog());
    expect(converted.map((e) => [e.sourceId, e.kind])).toEqual([
      ["e1", "pi.user"],
      ["e2", "pi.assistant"],
      ["e3", "pi.tool-result"],
      ["e4", "pi.assistant"],
      ["e5", "pi.compaction"],
      ["e6", "pi.user"],
    ]);
    const compaction = converted[4];
    expect(compaction.headSourceId).toBe("e4");
    expect(JSON.stringify(compaction.model![0].content)).toContain("<summary>\\nAsked about the readme.\\n</summary>");
    expect(converted[2].data).toEqual({ diagnostics: [] });
  });

  test("Letta's bookkeeping fields are left behind and the message keeps what pi-ai reads", () => {
    const [user, assistant, result] = lettaLogEntries(sampleLog());
    expect(Object.keys(user.model![0]).sort()).toEqual(["content", "role", "timestamp"]);
    expect(assistant.model![0]).not.toHaveProperty("metadata");
    expect(assistant.model![0]).toMatchObject({ role: "assistant", api: "openai-codex-responses", provider: "openai-codex", stopReason: "toolUse" });
    expect(result.model![0]).toMatchObject({ role: "toolResult", toolCallId: "call-1", toolName: "Read", isError: false });
    expect(user.model![0].timestamp).toBe(Date.parse("2026-10-01T10:00:01.000Z"));
  });

  test("each entry remembers the log line it came from, for Learn's cursors", () => {
    expect(lettaLogEntries(sampleLog()).map((e) => e.line)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("a reply off the main path is kept where it was written, for the thread only", () => {
    const text = logText([
      headerLine(),
      userLine("a", null, "2026-10-01T10:00:01.000Z", "first try"),
      assistantLine("b", "a", "2026-10-01T10:00:02.000Z", "abandoned answer"),
      userLine("c", null, "2026-10-01T10:00:03.000Z", "second try"),
      assistantLine("d", "c", "2026-10-01T10:00:04.000Z", "kept answer"),
    ]);
    const converted = lettaLogEntries(text);
    expect(converted.map((e) => [e.sourceId, e.kind])).toEqual([
      ["a", "loki.branch"],
      ["b", "loki.branch"],
      ["c", "pi.user"],
      ["d", "pi.assistant"],
    ]);
    expect(converted[1].model).toBeUndefined();
    expect(foldSteps(converted.flatMap(entrySteps))).toEqual(rowsFromDisk(text));
  });

  test("a compaction whose kept entry is not on the path is left out", () => {
    const text = logText([
      headerLine(),
      userLine("a", null, "2026-10-01T10:00:01.000Z", "hi"),
      { type: "compaction", id: "x", parentId: "a", timestamp: "2026-10-01T10:00:02.000Z", summary: "s", firstKeptEntryId: "gone" },
      userLine("b", "x", "2026-10-01T10:00:03.000Z", "again"),
    ]);
    expect(lettaLogEntries(text).map((e) => [e.sourceId, e.kind])).toEqual([
      ["a", "pi.user"],
      ["b", "pi.user"],
    ]);
  });

  test("the session header's folder is read; a log without one has none", () => {
    expect(lettaLogCwd(sampleLog())).toBe("/tmp/project");
    expect(lettaLogCwd(logText([userLine("a", null, "2026-10-01T10:00:01.000Z", "hi")]))).toBeUndefined();
  });
});
