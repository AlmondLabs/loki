import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { foldSteps, ThreadModel } from "../core/attention/thread.ts";
import { messageSteps } from "../core/attention/pi-steps.ts";
import { THOUGHT_MAX } from "../core/attention/transcript.ts";
import { Thought } from "../app/src/item/thought.tsx";

// Plan 097, U9: what the agent thought, kept on the row it led to and drawn as AI Elements' Reasoning.

const at = (s: number) => new Date(Date.UTC(2026, 10, 12, 9, 0, s)).toISOString();

describe("a thought on the thread", () => {
  test("streamed pieces ride the reply that follows, with how long the agent thought", () => {
    const t = new ThreadModel();
    t.apply({ kind: "thinking", text: "The table has ", at: at(0), chunk: true });
    t.apply({ kind: "thinking", text: "a date column.", at: at(5), chunk: true });
    t.apply({ kind: "assistant", text: "grouped", at: at(12), chunk: true });
    t.settle();
    expect(t.rows()?.at(-1)).toMatchObject({ role: "assistant", text: "grouped", thought: "The table has a date column.", thought_ms: 12_000 });
  });

  test("the whole thought that comes with the written reply keeps the time the streamed one began", () => {
    const t = new ThreadModel();
    t.apply({ kind: "thinking", text: "Twelve weeks.", at: at(0), chunk: true });
    t.apply({ kind: "assistant", text: "grouped", at: at(4), chunk: true });
    t.apply({ kind: "thinking", text: "Twelve weeks.", at: at(4) });
    t.apply({ kind: "assistant", text: "grouped", at: at(4) });
    expect(t.rows()?.at(-1)).toMatchObject({ text: "grouped", thought: "Twelve weeks.", thought_ms: 4000 });
  });

  test("a thought before a call rides the call's row", () => {
    const rows = foldSteps([
      { kind: "thinking", text: "Read it first.", at: at(0) },
      { kind: "call", name: "Read", args: { path: "a.csv" }, id: "c1", at: at(3) },
    ]);
    expect(rows[0]).toMatchObject({ role: "tool", thought: "Read it first.", thought_ms: 3000 });
  });

  test("a stored message's thinking part is the row's thought, untimed", () => {
    const rows = foldSteps(
      messageSteps(
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Twelve weeks." },
            { type: "text", text: "grouped" },
          ],
        },
        at(0),
      ),
    );
    expect(rows).toEqual([{ role: "assistant", text: "grouped", at: at(0), thought: "Twelve weeks." }]);
  });

  test("a long thought is cut on the row; the person's next message drops one that led nowhere", () => {
    const long = foldSteps([
      { kind: "thinking", text: "x".repeat(THOUGHT_MAX + 50), at: null },
      { kind: "assistant", text: "ok", at: null },
    ]);
    expect(long[0].thought).toHaveLength(THOUGHT_MAX);
    const dropped = foldSteps([
      { kind: "thinking", text: "hm", at: null },
      { kind: "user", raw: "stop", at: null },
      { kind: "assistant", text: "stopped", at: null },
    ]);
    expect(dropped.every((r) => r.thought === undefined)).toBe(true);
  });
});

describe("the Thought line", () => {
  test("folds to how long the agent thought, and says only 'Thought' when that is not known", () => {
    const timed = renderToStaticMarkup(createElement(Thought, { rows: [{ role: "assistant", text: "ok", thought: "hm", thought_ms: 12_400 }] }));
    expect(timed).toContain("Thought for 12 seconds");
    const untimed = renderToStaticMarkup(createElement(Thought, { rows: [{ role: "assistant", text: "ok", thought: "hm" }] }));
    expect(untimed).toContain(">Thought<");
    expect(untimed).not.toContain("few seconds");
  });

  test("draws nothing for rows with no thought", () => {
    expect(renderToStaticMarkup(createElement(Thought, { rows: [{ role: "assistant", text: "ok" }] }))).toBe("");
  });
});
