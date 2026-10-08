import { describe, expect, test } from "bun:test";
import { TOOL_TEXT_MAX, toTranscript, toolInput, toolOutput, toolStep } from "../core/harness.ts";
import { applyEvent, emptyLive } from "../core/attention/model.ts";
import { isNamedStep, isWorkRow, lastFailure, stepFailed, stepTarget, stepVerb, toolRuns, workSummary } from "../app/src/shared/toolSteps.ts";
import type { TranscriptRow } from "../core/attention/transcript.ts";

const bash = (failed = false): TranscriptRow => ({ role: "tool", text: "Bash · ls", tool: { name: "Bash", ...(failed ? { failed: true } : {}) } });
const read = (failed = false): TranscriptRow => ({ role: "tool", text: "Read · a.ts", tool: { name: "Read", ...(failed ? { failed: true } : {}) } });

describe("the line for a run of tools", () => {
  test("commands first, then the other tools, then what failed", () => {
    expect(workSummary([bash()])).toBe("Ran a command");
    expect(workSummary([bash(), bash(), bash()])).toBe("Ran 3 commands");
    expect(workSummary([read(), read()])).toBe("Used 2 tools");
    expect(workSummary([read()])).toBe("Used a tool");
    expect(workSummary([bash(), read(true), ...Array.from({ length: 8 }, () => read())])).toBe("Ran a command, used 9 tools · 1 failed");
    expect(workSummary([bash(), read()], true)).toBe("Working");
  });

  test("a step reads as a verb and what it was done to; old rows without a step still read by their label", () => {
    expect(stepVerb("Bash")).toBe("Ran");
    expect(stepVerb("Grep")).toBe("Searched");
    expect(stepVerb("mcp_thing")).toBe("Used mcp_thing");
    expect(stepTarget({ role: "tool", text: "Read · app/src/x.ts" })).toBe("app/src/x.ts");
    expect(stepTarget({ role: "tool", text: "Bash" })).toBeNull();
  });

  test("a described command reads by its description; the command stays the step's input", () => {
    const step = toolStep("Bash", { command: "cd backend && grep -n x tests/*.py", description: "Find hard-coded names in tests" });
    expect(step).toMatchObject({ input: "cd backend && grep -n x tests/*.py", description: "Find hard-coded names in tests" });
    const row: TranscriptRow = { role: "tool", text: "Bash · cd backend && grep -n x tests/*.py", tool: step };
    expect(stepTarget(row)).toBe("Find hard-coded names in tests");
    expect(workSummary([row])).toBe("Ran Find hard-coded names in tests");
    expect(workSummary([{ ...row, tool: { ...step, failed: true } }])).toBe("Ran Find hard-coded names in tests · failed");
    expect(workSummary([row, row])).toBe("Ran 2 commands");
    expect(workSummary([row], true)).toBe("Working");
  });

  test("no description, or only a description so far: no second copy of it", () => {
    expect(toolStep("Bash", { command: "ls" }).description).toBeUndefined();
    const early = toolStep("Bash", { description: "List files" }); // the command has not streamed in yet
    expect(early.input).toBe("List files");
    expect(early.description).toBeUndefined();
    expect(toolStep("Bash", { command: "ls", description: "  two\nlines " }).description).toBe("two");
  });

  test("consecutive tool rows are one run; a message or a break ends it", () => {
    const rows: TranscriptRow[] = [{ role: "user", text: "go" }, bash(), read(), { role: "assistant", text: "ok" }, bash(), read(), read()];
    expect([...toolRuns(rows)]).toEqual([
      [1, 3],
      [4, 7],
    ]);
    expect([...toolRuns(rows, 0, (k) => k === 5)]).toEqual([
      [1, 3],
      [4, 5],
      [5, 7],
    ]);
    expect([...toolRuns(rows, 5)]).toEqual([[5, 7]]); // a window starting mid-run starts the run there
  });
});

describe("tool inputs and outputs are kept", () => {
  test("the input a reader recognises in full, else the whole input; outputs as text, capped", () => {
    expect(toolInput("Bash", { command: "ls -la\nwc -l x" })).toBe("ls -la\nwc -l x");
    expect(toolInput("Custom", '{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(toolInput("Bash", '{"comm')).toBeUndefined(); // still streaming
    expect(toolOutput([{ type: "text", text: "one" }, { type: "text", text: "two" }])).toBe("one\ntwo");
    const long = toolOutput("x".repeat(TOOL_TEXT_MAX + 10))!;
    expect(long.startsWith("x".repeat(TOOL_TEXT_MAX))).toBe(true);
    expect(long.endsWith("10 more characters")).toBe(true);
  });

  test("Letta's history pairs a call with its return by id; one row for a call and its approval request", () => {
    const rows = toTranscript([
      { message_type: "tool_call_message", tool_call: { name: "Bash", arguments: '{"command":"ls"}', tool_call_id: "c1" } },
      { message_type: "approval_request_message", tool_call: { name: "Bash", arguments: '{"command":"ls"}', tool_call_id: "c1" } },
      { message_type: "tool_return_message", tool_call_id: "c1", tool_return: "a.ts", status: "error" },
    ]);
    expect(rows).toEqual([{ role: "tool", text: "Bash · ls", at: null, tool: { name: "Bash", id: "c1", input: "ls", output: "a.ts", failed: true } }]);
  });

  test("live, the input fills in as it streams and the result lands on its row", () => {
    const l = emptyLive();
    const rt = { agent_id: "a", conversation_id: "c" };
    const delta = (d: Record<string, unknown>) => ({ type: "stream_delta", runtime: rt, delta: d }) as never;
    applyEvent(l, delta({ message_type: "tool_call_message", tool_call: { name: "Bash", tool_call_id: "c1", arguments: '{"comm' } }), "2026-09-26T09:00:00Z");
    expect(l.tail[0].tool).toEqual({ name: "Bash", id: "c1" });
    applyEvent(l, delta({ message_type: "tool_call_message", tool_call: { name: "Bash", tool_call_id: "c1", arguments: 'and":"ls"}' } }), "2026-09-26T09:00:01Z");
    expect(l.tail[0]).toMatchObject({ text: "Bash · ls", tool: { input: "ls" } });
    applyEvent(l, delta({ message_type: "tool_return_message", tool_call_id: "c1", tool_return: "a.ts", status: "success" }), "2026-09-26T09:00:02Z");
    expect(l.tail[0].tool).toEqual({ name: "Bash", id: "c1", input: "ls", output: "a.ts" });
  });
});

describe("a stretch of work", () => {
  const at = (m: number) => new Date(Date.UTC(2026, 8, 30, 16, m)).toISOString();
  const bg = (name: string, m: number, failed = false): TranscriptRow => ({ role: "event", text: `background task exec_${m} ${failed ? "failed" : "completed"}`, summary: `Exec command "${name}" ${failed ? "failed" : "completed"}`, detail: failed ? "tasks failed ELB health checks" : "ok", at: at(m) });
  const tool = (name: string, m: number): TranscriptRow => ({ role: "tool", text: `${name} · x`, tool: { name }, at: at(m) });
  const skill: TranscriptRow = { role: "event", text: "skill loaded", summary: "fmt-data-analyst", detail: "# skill", at: at(1) };
  const rows = [bg("Revalidate approved dev deployment targets", 0), tool("Read", 1), skill, tool("Grep", 2), tool("Read", 2), bg("Create scoped Dealshield task security group", 5), tool("Bash", 6), bg("Deploy approved Dealshield image and ECS routing", 14, true), tool("Read", 14)];

  test("background tasks and skills are part of it; canvas activity and compactions are not", () => {
    expect(rows.every(isWorkRow)).toBe(true);
    expect(isWorkRow({ role: "event", text: "canvas activity" })).toBe(false);
    expect(isWorkRow({ role: "event", text: "context compacted" })).toBe(false);
    expect([...toolRuns([{ role: "user", text: "go" }, ...rows, { role: "assistant", text: "done" }])]).toEqual([[1, 10]]);
  });

  test("one line: how long, what ran, what failed; the failure is found without opening it", () => {
    expect(workSummary(rows)).toBe("Worked 14 min · 3 background tasks, a command, 5 tools · 1 failed");
    expect(workSummary(rows, true)).toBe("Working · 14 min");
    expect(stepFailed(rows[7])).toBe(true);
    expect(lastFailure(rows)).toBe(7);
    expect(stepTarget(rows[7])).toBe("Deploy approved Dealshield image and ECS routing");
    expect(stepVerb("Background task")).toBe("Ran in background");
  });

  test("opened: every step in one flat list; background tasks, commands and failures in full, the rest quieter", () => {
    expect(rows.map(isNamedStep)).toEqual([true, false, false, false, false, true, true, true, false]);
  });
});
