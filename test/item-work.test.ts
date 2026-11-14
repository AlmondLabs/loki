import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptRow } from "../core/attention/transcript.ts";
import { AgentTurn } from "../app/src/item/agent-turn.tsx";
import { StepOpened, Work } from "../app/src/item/work.tsx";

// Plan 097, U4: the agent's turn and its work on AI Elements, rendered without a browser.

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const bash = (over: Partial<NonNullable<TranscriptRow["tool"]>> = {}): TranscriptRow => ({
  role: "tool",
  text: "Bash · python chart.py",
  tool: { name: "Bash", input: "python chart.py", description: "draw the chart", output: "saved chart.png", ...over },
});

describe("AgentTurn", () => {
  test("a working turn carries the loader, which stops under reduced motion; a done one has none", () => {
    const working = html(createElement(AgentTurn, { agentName: "friday", state: "working", failed: 0, took: null, parts: [], draw: () => null }));
    expect(working).toContain("animate-spin");
    expect(working).toContain("motion-reduce:animate-none");
    expect(working).toContain("working");
    const done = html(createElement(AgentTurn, { agentName: "friday", state: "done", failed: 0, took: "2 min", parts: [], draw: () => null }));
    expect(done).not.toContain("animate-spin");
    expect(done).toContain("Worked 2 min");
  });

  test("a done turn has no state badge; the others keep theirs", () => {
    const turn = (state: "done" | "needs you" | "failed") =>
      html(createElement(AgentTurn, { agentName: "friday", state, failed: 2, took: null, parts: [], draw: () => null }));
    expect(turn("done")).not.toContain("data-state");
    expect(turn("done")).toContain("friday&#x27;s turn, done");
    expect(turn("needs you")).toContain('data-state="needs you"');
    expect(turn("failed")).toContain("2 failed");
  });

  test("a turn with no reasoning recorded shows no reasoning line", () => {
    const out = html(createElement(AgentTurn, { agentName: "friday", state: "done", failed: 0, took: null, parts: [], draw: () => null }));
    expect(out).not.toContain("Thought for");
    expect(out).not.toContain("Thinking");
  });
});

describe("Work", () => {
  // Closed, a stretch is its header alone; its running step shimmers once opened, which is checked in the app.
  test("a running stretch shimmers its closed header", () => {
    const out = html(createElement(Work, { rows: [bash(), bash({ output: undefined })], running: true, arrived: false }));
    expect(out).toContain("shimmer");
  });

  test("a done stretch does not shimmer, and names its failure under the closed line", () => {
    const out = html(createElement(Work, { rows: [bash(), bash({ failed: true, output: "boom" })], running: false, arrived: false }));
    expect(out).not.toContain("shimmer");
    expect(out).toContain("failed");
  });
});

describe("an opened step", () => {
  test("is AI Elements' Tool: its name, its state, the command and its output", () => {
    const out = html(createElement(StepOpened, { row: bash(), running: false }));
    expect(out).toContain("Bash");
    expect(out).toContain(">done<");
    expect(out).toContain(">Command<");
    expect(out).toContain("python chart.py");
    expect(out).toContain("saved chart.png");
  });

  test("a failed one says so and shows its output in the failure colour", () => {
    const out = html(createElement(StepOpened, { row: bash({ failed: true, output: "Traceback: boom" }), running: false }));
    expect(out).toContain(">failed<");
    expect(out).toContain("output · failed");
    expect(out).toContain("text-destructive");
    expect(out).toContain("Traceback: boom");
  });

  test("a running one has nothing back yet", () => {
    const out = html(createElement(StepOpened, { row: bash({ output: undefined }), running: true }));
    expect(out).toContain(">running<");
    expect(out).toContain("nothing came back yet");
  });

  test("a sub-agent's step is a Task: what it was asked and what it reported", () => {
    const row: TranscriptRow = {
      role: "tool",
      text: "Task · reproduce in Safari",
      tool: { name: "Task", description: "reproduce the login loop in Safari", output: "Reproduced: SameSite=Strict drops the cookie." },
    };
    const out = html(createElement(StepOpened, { row, running: false }));
    expect(out).toContain("Asked: reproduce the login loop in Safari");
    expect(out).toContain("Reproduced: SameSite=Strict drops the cookie.");
    expect(out).not.toContain(">Command<");
  });

  test("a background task's notice is a Task with its detail", () => {
    const row: TranscriptRow = { role: "event", text: "background task finished", detail: "npm test: 245 passed" };
    const out = html(createElement(StepOpened, { row, running: false }));
    expect(out).toContain("npm test: 245 passed");
  });

  test("a finished step reads at full strength, not faded as not yet run", () => {
    const read: TranscriptRow = { role: "tool", text: "Read · notes.txt", tool: { name: "Read", input: "notes.txt", output: "old" } };
    const out = html(createElement(Work, { rows: [bash(), read], running: false, arrived: false }));
    expect(out).not.toContain("text-muted-foreground/50");
  });
});

describe("thoughts on the work line (plan 2026-11-14-0852, 4)", () => {
  const read: TranscriptRow = { role: "tool", text: "Read · signups.csv", tool: { name: "Read" }, thought: "Look at the file first.", thought_ms: 3000 };
  const answer: TranscriptRow = { role: "assistant", text: "There are 40 signups.", thought: "Count the rows.", thought_ms: 2000 };

  test("a turn that thinks, reads, thinks and answers is one work line: both thoughts are steps in it, in order", async () => {
    const { thoughtsIntoWork } = await import("../app/src/item/entries.ts");
    const steps = { kind: "steps" as const, key: "r-0", rows: [read], running: false, arrived: false };
    const message = { kind: "message" as const, key: "r-1", row: answer, last: true, first: true, arrived: false };
    const { into, folded } = thoughtsIntoWork([[steps, message]]);
    expect(into.get("r-0")).toEqual([answer]);
    expect([...folded]).toEqual(["r-1"]);
    // A reply with no work before it keeps its own line.
    expect(thoughtsIntoWork([[message]]).folded.size).toBe(0);
  });

  test("the line names its one step, and opened lists each thought where it came", () => {
    const closed = html(createElement(Work, { rows: [read], thoughts: [answer], running: false, arrived: false }));
    expect(closed).toContain("Read signups.csv");
    expect(closed).not.toContain("Used a tool");
  });
});
