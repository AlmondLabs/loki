import { describe, expect, test } from "vitest";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { ChatEventConverter, unansweredDetail, unansweredWhy } from "../daemon/chat-events.ts";
import { DOCTOR_INSTRUCTIONS } from "../daemon/doctor.ts";
import { FAILURE_RULE } from "../daemon/memory.ts";
import { INSTRUCTIONS, reflectionJob } from "../daemon/reflection.ts";
import { learnJob } from "../daemon/learn.ts";
import { formatTranscript } from "../mod/recall-worker.ts";
import { TOOL_TEXT_MAX, withResult } from "../core/harness.ts";
import type { TranscriptRow } from "../core/attention/transcript.ts";

const said = (role: "user" | "assistant", text: string): TranscriptRow => ({ role, text });
/** A tool row as the thread folds it: the step's result through withResult, as a live chat and history both do. */
const call = (name: string, input: string, output: string, failed = false): TranscriptRow => ({
  role: "tool",
  text: name,
  tool: withResult({ name, input }, output, failed),
});

describe("reflection reads the calls that failed, and the one that fixed each (plan 033)", () => {
  const rows = [
    said("user", "count the pages"),
    call("bash", "python count.py", "/bin/bash: python: command not found", true),
    call("read", "count.py", "print(1)"),
    call("bash", "python3 count.py", "12"),
    call("bash", "ls", "count.py"),
    said("assistant", "It has 12 pages."),
  ];

  test("a failed call is a line where it happened, and the next call of that tool that worked follows it", () => {
    expect(formatTranscript(rows, "Ada", { failedCalls: true }).split("\n")).toEqual([
      "you: count the pages",
      "[failed bash: python count.py → /bin/bash: python: command not found]",
      "[then bash worked: python3 count.py]",
      "Ada: It has 12 pages.",
    ]);
  });

  test("without it, as Learn reads, the calls stay out", () => {
    expect(formatTranscript(rows, "Ada")).toBe("you: count the pages\nAda: It has 12 pages.");
  });

  test("a long command and a long error are cut, and the error's last line is the one shown", () => {
    const line = formatTranscript([call("bash", `echo ${"x".repeat(400)}`, `Traceback\n  File x\nModuleNotFoundError: ${"y".repeat(400)}\n`, true)], null, {
      failedCalls: true,
    });
    expect(line).toMatch(/^\[failed bash: echo x+… → ModuleNotFoundError: y+…\]$/);
    expect(line.length).toBeLessThan(440);
  });

  test("the harness's note is read past: the error before it is shown, and the note only when it says more than an exit code", () => {
    const failed = (output: string) => formatTranscript([call("bash", "run", output, true)], null, { failedCalls: true });
    expect(failed("/bin/bash: python: command not found\n\n<harness>\n[error] Command exited with code 127\n</harness>")).toBe(
      "[failed bash: run → /bin/bash: python: command not found]",
    );
    expect(failed("partial output\n<harness>\n[error] Command timed out after 60 seconds\n</harness>")).toBe(
      "[failed bash: run → partial output — Command timed out after 60 seconds]",
    );
    expect(failed("<harness>\n[error] Command timed out after 30 seconds\n</harness>")).toBe("[failed bash: run → Command timed out after 30 seconds]");
  });

  test("the error is read from the whole result, before the step's output is cut", () => {
    const step = withResult(
      { name: "bash", input: "make" },
      `${"log line\n".repeat(1000)}make: *** [all] Error 2\n<harness>\n[error] Command exited with code 2\n</harness>`,
      true,
    );
    expect(step.output?.length).toBeLessThan(TOOL_TEXT_MAX + 100);
    expect(step.error).toBe("make: *** [all] Error 2");
    expect(withResult({ name: "bash" }, "fine", false).error).toBeUndefined();
  });

  test("a call still running (no result yet) is not shown", () => {
    expect(formatTranscript([{ role: "tool", text: "bash", tool: { name: "bash", input: "sleep 9" } }], null, { failedCalls: true })).toBe("");
  });

  test("only reflection asks for them", () => {
    expect(reflectionJob.failedCalls).toBe(true);
    // Learn builds its job from its stores; it only reads them when it runs.
    expect(learnJob({ store: {}, state: {}, chats: {} } as never).failedCalls).toBeUndefined();
  });

  test("reflection and the memory review share the rule for when a failure is a lesson", () => {
    expect(INSTRUCTIONS).toContain(FAILURE_RULE);
    expect(DOCTOR_INSTRUCTIONS).toContain(FAILURE_RULE);
    expect(INSTRUCTIONS).not.toContain("which command failed");
    expect(DOCTOR_INSTRUCTIONS).not.toContain("which command failed");
  });
});

describe("a turn that went unanswered says why", () => {
  test("the provider's message is passed on, on one line and cut", () => {
    expect(unansweredWhy({ status: "unanswered", reason: "model_error", detail: "429 rate limit\nretry later" })).toBe(
      "model_error: 429 rate limit retry later",
    );
    expect(unansweredWhy({ status: "unanswered", reason: "no_model" })).toBe("no_model");
    expect(unansweredDetail({ code: 413 })).toBe('{"code":413}');
    expect(unansweredDetail("z".repeat(500))?.length).toBe(300);
    expect(unansweredDetail("  ")).toBeNull();
  });

  const settled = (detail?: string) =>
    ({
      type: "submission",
      record: { id: 1, conversationId: 1, type: "input", status: "unanswered", reason: "model_error", ...(detail ? { detail } : {}) },
    }) as unknown as AgentEvent;

  test("a chat's error line keeps its hint and adds what the provider said", () => {
    const [error] = new ChatEventConverter().convert(settled("429 rate limit"), "2026-10-26T10:00:00.000Z");
    expect(error.kind).toBe("error");
    expect(error.kind === "error" && error.message).toMatch(/^the model could not be reached — .* \(429 rate limit\)$/);
  });

  test("with nothing recorded, the line is as it was", () => {
    const [error] = new ChatEventConverter().convert(settled(), "2026-10-26T10:00:00.000Z");
    expect(error.kind === "error" && error.message).toMatch(/for the chat$/);
  });
});
