import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptRow } from "../core/attention/transcript.ts";
import { AgentTurn } from "../app/src/item/agent-turn.tsx";
import { Step, StepOpened, Work } from "../app/src/item/work.tsx";

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const times = (out: string, text: string) => out.split(text).length - 1;
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
  test("a running stretch shimmers its closed header", () => {
    const out = html(createElement(Work, { rows: [bash(), bash({ output: undefined })], running: true, arrived: false }));
    expect(out).toContain("shimmer");
  });

  test("a done stretch does not shimmer, and names its failure under the closed line", () => {
    const out = html(createElement(Work, { rows: [bash(), bash({ failed: true, output: "boom" })], running: false, arrived: false }));
    expect(out).not.toContain("shimmer");
    expect(out).toContain("failed");
  });

  test("a failure the agent went on past is grey; one the turn stopped on is red (plan 2026-11-15-1035, R16)", () => {
    const rows = [bash(), bash({ failed: true, output: "boom" })];
    const failureLine = (out: string) => /<button[^>]*class="([^"]*)"[^>]*>(?:(?!<\/button>).)*failed(?:<\/span>)*<\/button>/.exec(out)?.[1] ?? "";
    const went = html(createElement(Work, { rows, running: false, arrived: false }));
    expect(failureLine(went)).toContain("text-muted-foreground");
    expect(failureLine(went)).not.toContain("text-loki-negative");
    const stopped = html(createElement(Work, { rows, running: false, arrived: false, stopped: true }));
    expect(failureLine(stopped)).toContain("text-loki-negative");
  });

  test("a finished stretch is marked with a checklist, not a terminal's prompt (R16)", () => {
    const out = html(createElement(Work, { rows: [bash()], running: false, arrived: false }));
    expect(out).toContain("lucide-list-checks");
    expect(out).not.toContain("lucide-square-terminal");
    expect(out).not.toContain("lucide-terminal");
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

  test("a sub-agent's step is a Task titled by its description: the prompt it was given, under Asked, and what it reported", () => {
    const prompt = "Open Safari, sign in twice and say where the cookie goes.";
    const row: TranscriptRow = {
      role: "tool",
      text: "Task · reproduce in Safari",
      tool: { name: "Task", description: "Reproduce the login loop in Safari", input: prompt, output: "Reproduced: SameSite=Strict drops the cookie." },
    };
    const out = html(createElement(StepOpened, { row, running: false }));
    expect(out).toMatch(/>Asked<\/h4><p[^>]*>Open Safari, sign in twice and say where the cookie goes.<\/p>/);
    expect(times(out, prompt)).toBe(1);
    expect(times(out, "Reproduce the login loop in Safari")).toBe(1);
    expect(out).toContain("Reproduced: SameSite=Strict drops the cookie.");
    expect(out).not.toContain(">Command<");
  });

  test("a background task's notice is a Task with its detail", () => {
    const row: TranscriptRow = { role: "event", text: "background task finished", detail: "npm test: 245 passed" };
    const out = html(createElement(StepOpened, { row, running: false }));
    expect(out).toContain("npm test: 245 passed");
  });

  test("a background notice is titled once, by its short title, left-aligned and cut to a line; its whole command shows once", () => {
    const row: TranscriptRow = {
      role: "event",
      text: "background task bg-1 completed",
      summary: "uv run pytest -q tests/a.py",
      command: "env -i HOME=/h uv run pytest -q tests/a.py",
      detail: "42 passed",
    };
    const out = html(createElement(StepOpened, { row, running: false }));
    expect(out).toMatch(/<button[^>]*class="[^"]*\btext-left\b[^"]*"/);
    expect(out).toMatch(/<p class="[^"]*\btruncate\b[^"]*">uv run pytest -q tests\/a.py<\/p>/);
    expect(times(out, ">uv run pytest -q tests/a.py<")).toBe(1);
    expect(out).toMatch(/>Command<\/h4><pre[^>]*>env -i HOME=\/h uv run pytest -q tests\/a.py<\/pre>/);
    expect(times(out, "env -i HOME=/h uv run pytest -q tests/a.py")).toBe(1);
    expect(out.indexOf(">Command<")).toBeLessThan(out.indexOf("42 passed"));
  });

  test("an old notice opens on its title and its raw summary, each once; one with no command, its title alone", () => {
    const raw = "cd /w &amp;&amp; npm test";
    const old: TranscriptRow = { role: "event", text: "background task finished", summary: "npm test", command: "cd /w && npm test", detail: "245 passed" };
    const out = html(createElement(StepOpened, { row: old, running: false }));
    expect(times(out, ">npm test<")).toBe(1);
    expect(times(out, raw)).toBe(1);
    const bare = html(createElement(StepOpened, { row: { ...old, command: undefined }, running: false }));
    expect(times(bare, "npm test")).toBe(1);
    expect(bare).not.toContain(">Command<");
  });

  test("a finished step reads at full strength, not faded as not yet run", () => {
    const read: TranscriptRow = { role: "tool", text: "Read · notes.txt", tool: { name: "Read", input: "notes.txt", output: "old" } };
    const out = html(createElement(Work, { rows: [bash(), read], running: false, arrived: false }));
    expect(out).not.toContain("text-muted-foreground/50");
  });
});

describe("a step's title stays on one line (plan 2026-11-23-1851, KTD8)", () => {
  const step = (row: TranscriptRow, active = false, waiting = false) => html(createElement(Step, { row, active, waiting, open: false, onToggle: () => {} }));
  const crm = (over: Partial<NonNullable<TranscriptRow["tool"]>> = {}) => bash({ description: "Run the CRM tests", ...over });

  test("a finished step's description is its title, cut inside its own element", () => {
    expect(step(crm())).toMatch(/<span class="[^"]*\btruncate\b[^"]*">Run the CRM tests<\/span>/);
  });

  test("a failed step's ending sits outside the cut title, and so does a waiting one's", () => {
    expect(step(crm({ failed: true }))).toMatch(/<span class="[^"]*\btruncate\b[^"]*">Run the CRM tests<\/span><span[^>]*> · failed<\/span>/);
    expect(step(crm({ output: undefined }), true, true)).toMatch(
      /<span class="[^"]*\btruncate\b[^"]*">Run the CRM tests<\/span><span[^>]*> · waiting on you<\/span>/,
    );
  });

  test("a running step's shimmering title is cut the same way", () => {
    expect(step(crm({ output: undefined }), true)).toMatch(/<span class="shimmer[^"]*\btruncate\b[^"]*"[^>]*>Run the CRM tests<\/span>/);
  });

  test("the failure under a closed stretch cuts its title and keeps failed", () => {
    const out = html(createElement(Work, { rows: [bash(), crm({ failed: true, output: "boom" })], running: false, arrived: false }));
    expect(out).toMatch(/<span class="[^"]*\btruncate\b[^"]*">Run the CRM tests<\/span><span[^>]*> failed<\/span>/);
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
    expect(thoughtsIntoWork([[message]]).folded.size).toBe(0);
  });

  test("the line names its one step, and opened lists each thought where it came", () => {
    const closed = html(createElement(Work, { rows: [read], thoughts: [answer], running: false, arrived: false }));
    expect(closed).toContain("Read signups.csv");
    expect(closed).not.toContain("Used a tool");
  });
});
