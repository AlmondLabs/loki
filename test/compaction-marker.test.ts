import { describe, expect, test } from "vitest";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { ChatEventConverter } from "../daemon/chat-events.ts";
import { entrySteps } from "../core/attention/pi-steps.ts";
import { COMPACTED_TEXT, foldSteps, ThreadModel, type Step } from "../core/attention/thread.ts";

const NOW = "2026-11-03T10:00:00.000Z";
const AT = Date.parse("2026-11-03T09:59:00.000Z");
const SUMMARY = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n## Goal\n- Ship it\n</summary>";

const compactionEntry = { kind: "pi.compaction", model: [{ role: "user", content: [{ type: "text", text: SUMMARY }], timestamp: AT }] };
const done: Step = { kind: "compaction", state: "done", detail: "## Goal\n- Ship it", at: new Date(AT).toISOString() };
const ended = (entry: object) => ({ type: "message_end", entry: { id: 1, conversationId: 1, ...entry } }) as unknown as AgentEvent;

describe("a compaction in history", () => {
  test("its entry is one step, the summary taken out of its wrapper", () => {
    expect(entrySteps(compactionEntry)).toEqual([done]);
  });

  test("it folds into one quiet row between the messages, the summary behind it", () => {
    const rows = foldSteps([{ kind: "user", raw: "go on", at: null }, ...entrySteps(compactionEntry), { kind: "assistant", text: "Done.", at: null }]);
    expect(rows.map((r) => [r.role, r.text])).toEqual([
      ["user", "go on"],
      ["event", COMPACTED_TEXT],
      ["assistant", "Done."],
    ]);
    expect(rows[1].detail).toBe("## Goal\n- Ship it");
  });
});

describe("a compaction as it happens", () => {
  test("one that holds the turn up shows while it runs; a background one does not", () => {
    const c = new ChatEventConverter();
    expect(c.convert({ type: "compaction_start", taskId: 7 as never, reason: "threshold", blocking: true }, NOW)).toEqual([
      { kind: "step", step: { kind: "compaction", state: "running", detail: null, at: NOW } },
    ]);
    expect(c.convert({ type: "compaction_start", taskId: 8 as never, reason: "threshold", blocking: false }, NOW)).toEqual([]);
  });

  test("its summary is the finished row, never a message from the person", () => {
    const c = new ChatEventConverter();
    expect(c.convert({ type: "message_start", message: compactionEntry.model[0] as never }, NOW)).toEqual([]);
    expect(c.convert(ended(compactionEntry), NOW)).toEqual([{ kind: "step", step: done }]);
  });

  test("a person's message still shows, when it is written", () => {
    const c = new ChatEventConverter();
    const message = { role: "user", content: [{ type: "text", text: "hello" }], timestamp: AT };
    expect(c.convert({ type: "message_start", message: message as never }, NOW)).toEqual([]);
    expect(c.convert(ended({ kind: "pi.user", model: [message] }), NOW)).toEqual([
      { kind: "step", step: { kind: "user", raw: "hello", at: new Date(AT).toISOString() } },
    ]);
  });

  test("an end says why it failed; a bare end takes away only a row it showed", () => {
    const c = new ChatEventConverter();
    c.convert({ type: "compaction_start", taskId: 7 as never, reason: "threshold", blocking: true }, NOW);
    expect(c.convert({ type: "compaction_end", taskId: 7 as never, reason: "threshold" }, NOW)).toEqual([
      { kind: "step", step: { kind: "compaction", state: "ended", detail: null, at: NOW } },
    ]);
    expect(c.convert({ type: "compaction_end", taskId: 8 as never, reason: "threshold" }, NOW)).toEqual([]);
    expect(c.convert({ type: "compaction_end", taskId: 9 as never, reason: "threshold", error: "prompt too long" }, NOW)).toEqual([
      { kind: "step", step: { kind: "compaction", state: "failed", detail: "prompt too long", at: NOW } },
    ]);
  });
});

describe("a compaction in the thread", () => {
  const running: Step = { kind: "compaction", state: "running", detail: null, at: NOW };

  test("the running row becomes the finished one in place, and a repeated start adds nothing", () => {
    const t = new ThreadModel();
    t.apply({ kind: "user", raw: "go on", at: NOW });
    t.apply(running);
    expect(t.apply(running).changed).toBe(false);
    expect(t.rows()?.map((r) => [r.text, r.summary ?? null])).toEqual([
      ["go on", null],
      ["compacting the chat", "summarising earlier turns…"],
    ]);
    t.apply(done);
    expect(t.rows()?.map((r) => [r.text, r.detail ?? null])).toEqual([
      ["go on", null],
      [COMPACTED_TEXT, "## Goal\n- Ship it"],
    ]);
  });

  test("a bare end takes the running row away; a failure says so", () => {
    const t = new ThreadModel();
    t.apply(running);
    t.apply({ kind: "compaction", state: "ended", detail: null, at: NOW });
    expect(t.rows() ?? []).toEqual([]);
    t.apply(running);
    t.apply({ kind: "compaction", state: "failed", detail: "prompt too long", at: NOW });
    expect(t.rows()?.map((r) => [r.text, r.detail])).toEqual([["compaction failed", "prompt too long"]]);
  });

  test("a running row stays across a history page, and a finished one pairs with the page's", () => {
    const t = new ThreadModel();
    t.apply(running);
    t.load([{ role: "user", text: "go on", at: NOW }]);
    expect(t.rows()?.map((r) => r.text)).toEqual(["go on", "compacting the chat"]);
    t.apply(done);
    t.load([
      { role: "user", text: "go on", at: NOW },
      { role: "event", text: COMPACTED_TEXT, summary: null, detail: "## Goal\n- Ship it" },
    ]);
    expect(t.rows()?.map((r) => r.text)).toEqual(["go on", COMPACTED_TEXT]);
  });
});
