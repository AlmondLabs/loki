import { describe, expect, test } from "bun:test";
import { TOOL_TEXT_MAX, toTranscript, toolInput, toolOutput } from "../core/harness.ts";
import { applyEvent, emptyLive } from "../core/attention/model.ts";
import { stepTarget, stepVerb, stepsSummary, toolRuns } from "../app/src/shared/toolSteps.ts";
import type { TranscriptRow } from "../core/attention/transcript.ts";

const bash = (failed = false): TranscriptRow => ({ role: "tool", text: "Bash · ls", tool: { name: "Bash", ...(failed ? { failed: true } : {}) } });
const read = (failed = false): TranscriptRow => ({ role: "tool", text: "Read · a.ts", tool: { name: "Read", ...(failed ? { failed: true } : {}) } });

describe("the line for a run of tools", () => {
  test("commands first, then the other tools, then what failed", () => {
    expect(stepsSummary([bash()])).toBe("Ran a command");
    expect(stepsSummary([bash(), bash(), bash()])).toBe("Ran 3 commands");
    expect(stepsSummary([read(), read()])).toBe("Used 2 tools");
    expect(stepsSummary([read()])).toBe("Used a tool");
    expect(stepsSummary([bash(), read(true), ...Array.from({ length: 8 }, () => read())])).toBe("Ran a command, used 9 tools (1 failed)");
    expect(stepsSummary([bash(), read()], true)).toBe("Running");
  });

  test("a step reads as a verb and what it was done to; old rows without a step still read by their label", () => {
    expect(stepVerb("Bash")).toBe("Ran");
    expect(stepVerb("Grep")).toBe("Searched");
    expect(stepVerb("mcp_thing")).toBe("Used mcp_thing");
    expect(stepTarget({ role: "tool", text: "Read · app/src/x.ts" })).toBe("app/src/x.ts");
    expect(stepTarget({ role: "tool", text: "Bash" })).toBeNull();
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
