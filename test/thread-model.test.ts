import { historySteps, applyEvent } from "./fixtures/letta-events.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatStatusOf, emptyLive } from "../core/attention/model.ts";
import { commandIdOf, foldSteps, ownSendKey, ThreadModel, type Step } from "../core/attention/thread.ts";
import type { TranscriptRow } from "../core/attention/transcript.ts";
import { conversationDirName } from "../core/desk-core.ts";
import { readLocalTranscriptPage } from "../daemon/import/letta-log.ts";

const rt = { agent_id: "a", conversation_id: "c" };
const delta = (message_type: string, extra: Record<string, unknown> = {}) => ({ type: "stream_delta", runtime: rt, delta: { message_type, ...extra } });
const msg = (message_type: string, extra: Record<string, unknown>) => ({ message_type, date: "2026-09-05T08:00:00Z", ...extra });
const tools = (rows: TranscriptRow[] | undefined) => (rows ?? []).filter((r) => r.role === "tool");

describe("app-server history as a thread", () => {
  test("protocol messages fold into a readable thread: markup stripped, machinery as events, reasoning and returns dropped", () => {
    const t = foldSteps(historySteps([
      msg("user_message", { content: "<system-reminder>x</system-reminder>go" }),
      msg("reasoning_message", { reasoning: "hmm" }),
      msg("tool_call_message", { tool_call: { name: "Bash" } }),
      msg("tool_return_message", { tool_return: "ok" }),
      msg("user_message", { content: "<task-notification><task-id>b1</task-id><status>completed</status><summary>ran</summary><result>a &gt; b</result></task-notification>" }),
      msg("assistant_message", { content: "Done." }),
    ]));
    expect(t.map((m) => `${m.role}:${m.text}`)).toEqual(["user:go", "tool:Bash", "event:background task b1 completed", "assistant:Done."]);
    expect(t[2]).toMatchObject({ summary: "ran", detail: "a > b" });
  });

  test("history with times yields rows with times; history without yields rows without", () => {
    expect(foldSteps(historySteps([
      { message_type: "user_message", content: "hi", date: "2026-09-23T08:00:00Z" },
      { message_type: "assistant_message", content: "hello", date: "2026-09-23T08:00:05Z" },
    ]))).toEqual([
      { role: "user", text: "hi", at: "2026-09-23T08:00:00Z" },
      { role: "assistant", text: "hello", at: "2026-09-23T08:00:05Z" },
    ]);
    const bare = foldSteps(historySteps([{ message_type: "assistant_message", content: "hello" }]));
    expect(bare).toEqual([{ role: "assistant", text: "hello" }]);
    expect("at" in bare[0]).toBe(false);
  });

  test("a call is paired with its return by id; its approval request with the same id is the same row", () => {
    const rows = foldSteps(historySteps([
      { message_type: "tool_call_message", tool_call: { name: "Bash", arguments: '{"command":"ls"}', tool_call_id: "c1" } },
      { message_type: "approval_request_message", tool_call: { name: "Bash", arguments: '{"command":"ls"}', tool_call_id: "c1" } },
      { message_type: "tool_return_message", tool_call_id: "c1", tool_return: "a.ts", status: "error" },
    ]));
    expect(rows).toEqual([{ role: "tool", text: "Bash · ls", tool: { name: "Bash", id: "c1", input: "ls", output: "a.ts", failed: true } }]);
  });
});

describe("one row per tool call", () => {
  const call = (name: string, id: string | null, args: unknown = undefined): Step => ({ kind: "call", name, args, id, at: null });
  const approval = (name: string, id: string | null): Step => ({ kind: "approval", name, args: undefined, id, at: null });

  test("live, an approval request with its own id, or none, belongs to the call it asks about", () => {
    const l = emptyLive();
    applyEvent(l, delta("tool_call_message", { tool_call: { name: "AskUserQuestion", tool_call_id: "t1" } }));
    applyEvent(l, delta("approval_request_message", { tool_call: { name: "AskUserQuestion", tool_call_id: "approval-9" } }));
    applyEvent(l, delta("approval_request_message", { tool_call: { name: "AskUserQuestion" } }));
    expect(tools(l.thread.rows()).length).toBe(1);
    // a genuinely new call of the same tool after some text is a new row
    applyEvent(l, delta("assistant_message", { content: "and again" }));
    applyEvent(l, delta("tool_call_message", { tool_call: { name: "AskUserQuestion", tool_call_id: "t2" } }));
    expect(tools(l.thread.rows()).length).toBe(2);
  });

  test("a second call of the same tool straight after the first is its own row, and gets its own result", () => {
    const rows = foldSteps([call("Read", "r1", { path: "a.ts" }), call("Read", "r2", { path: "b.ts" }), { kind: "result", id: "r2", output: "b", failed: false }, { kind: "result", id: "r1", output: "a", failed: false }]);
    expect(rows.map((r) => [r.text, r.tool?.output])).toEqual([["Read · a.ts", "a"], ["Read · b.ts", "b"]]);
  });

  test("an approval with no open call is a call; once something was said after a call, it is no longer open", () => {
    expect(tools(foldSteps([approval("Bash", "p1")]))).toMatchObject([{ tool: { name: "Bash", id: "p1" } }]);
    const rows = foldSteps([call("Bash", "c1"), { kind: "assistant", text: "one more", at: null }, approval("Bash", "p2")]);
    expect(tools(rows).map((r) => r.tool?.id)).toEqual(["c1", "p2"]);
    // a call that already came back is not open either
    expect(tools(foldSteps([call("Bash", "c1"), { kind: "result", id: "c1", output: "ok", failed: false }, approval("Bash", "p3")])).length).toBe(2);
  });

  test("live, the input fills in as it streams and the result lands on its row", () => {
    const l = emptyLive();
    applyEvent(l, delta("tool_call_message", { tool_call: { name: "Bash", tool_call_id: "c1", arguments: '{"comm' } }), "2026-09-26T09:00:00Z");
    expect(l.thread.rows()![0].tool).toEqual({ name: "Bash", id: "c1" });
    applyEvent(l, delta("tool_call_message", { tool_call: { name: "Bash", tool_call_id: "c1", arguments: 'and":"ls"}' } }), "2026-09-26T09:00:01Z");
    expect(l.thread.rows()![0]).toMatchObject({ text: "Bash · ls", tool: { input: "ls" } });
    applyEvent(l, delta("tool_return_message", { tool_call_id: "c1", tool_return: "a.ts", status: "success" }), "2026-09-26T09:00:02Z");
    expect(l.thread.rows()![0].tool).toEqual({ name: "Bash", id: "c1", input: "ls", output: "a.ts" });
  });

  test("the label and the input pick the same argument", () => {
    const [row] = foldSteps([call("Task", "t1", { description: "Explore the code", prompt: "Find where rows are built" })]);
    expect(row.text).toBe("Task · Find where rows are built");
    expect(row.tool).toMatchObject({ input: "Find where rows are built", description: "Explore the code" });
  });
});

describe("the live thread", () => {
  test("user, tool and assistant rows fold in order; own sends are not echoed twice; streaming settles", () => {
    const l = emptyLive();
    l.thread.own({ role: "user", text: "hello" }, "hello");
    applyEvent(l, delta("user_message", { content: "hello" }));
    expect(l.thread.rows()).toMatchObject([{ role: "user", text: "hello" }]); // echo recognised
    applyEvent(l, { type: "update_loop_status", runtime: rt, loop_status: { status: "PROCESSING_API_RESPONSE" } });
    expect(chatStatusOf(l)).toBe("thinking");
    applyEvent(l, delta("assistant_message", { content: "Let me " }));
    expect(chatStatusOf(l)).toBe("streaming");
    applyEvent(l, delta("tool_call_message", { tool_call: { name: "Bash", tool_call_id: "t1" } }));
    applyEvent(l, delta("tool_call_message", { tool_call: { name: "Bash", tool_call_id: "t1" } })); // same call, more deltas
    expect(l.thread.rows()).toMatchObject([{ role: "user", text: "hello" }, { role: "assistant", text: "Let me" }, { role: "tool", text: "Bash" }]);
    applyEvent(l, delta("assistant_message", { content: "done." }));
    applyEvent(l, { type: "update_loop_status", runtime: rt, loop_status: { status: "WAITING_ON_INPUT" } });
    expect(l.thread.rows()!.at(-1)).toMatchObject({ role: "assistant", text: "done." });
    expect(l.lastAssistantText).toBe("done.");
    expect(chatStatusOf(l)).toBe("idle");
    // a message typed elsewhere (Desktop) shows up as a user row
    applyEvent(l, delta("user_message", { content: "from desktop" }));
    expect(l.thread.rows()!.at(-1)).toMatchObject({ role: "user", text: "from desktop" });
  });

  test("the desk block and a loaded skill become event rows; the user's own words stay a user row", () => {
    const l = emptyLive();
    applyEvent(l, delta("user_message", { content: 'build it\n\n<loki-desk desk="c">\n- moved "x" to (1, 2)\n</loki-desk>' }));
    expect(l.thread.rows()).toMatchObject([
      { role: "event", text: "canvas activity", summary: "1 gesture on c", detail: 'moved "x" to (1, 2)' },
      { role: "user", text: "build it" },
    ]);
    // a message that is only machinery changes the thread but is not the user speaking
    const r = applyEvent(l, delta("user_message", { content: '<skill_content name="unslop">\n# Unslop\n</skill_content>' }));
    expect(r).toEqual({ changed: true, userSpoke: false });
    expect(l.thread.rows()![2]).toMatchObject({ role: "event", text: "skill loaded", summary: "unslop", detail: "# Unslop" });
  });

  test("user, tool, event and settled assistant rows carry the time they arrived; the reply keeps the time it started", () => {
    const l = emptyLive();
    applyEvent(l, delta("user_message", { content: "go" }), "2026-09-23T09:00:00.000Z");
    applyEvent(l, delta("assistant_message", { content: "Let " }), "2026-09-23T09:00:02.000Z");
    applyEvent(l, delta("assistant_message", { content: "me" }), "2026-09-23T09:00:03.000Z");
    expect(l.thread.rows()!.at(-1)).toMatchObject({ text: "Let me", at: "2026-09-23T09:00:02.000Z" });
    applyEvent(l, delta("tool_call_message", { tool_call: { name: "Bash", tool_call_id: "t1" } }), "2026-09-23T09:00:04.000Z");
    l.thread.beginCommand("/reload", "2026-09-23T09:00:06.000Z");
    expect(l.thread.rows()!.map((r) => [r.role, r.at])).toEqual([
      ["user", "2026-09-23T09:00:00.000Z"],
      ["assistant", "2026-09-23T09:00:02.000Z"],
      ["tool", "2026-09-23T09:00:04.000Z"],
      ["event", "2026-09-23T09:00:06.000Z"],
    ]);
    expect(l.thread.streaming).toBe(false);
  });

  test("an image you sent is known again in its echo, which carries the picture as an [image] line", () => {
    const t = new ThreadModel();
    t.own({ role: "user", text: "look", images: ["data:image/png;base64,x"] }, ownSendKey("look"));
    expect(t.apply({ kind: "user", raw: "look\n[image]", at: null }).spoke).toBe("look\n[image]");
    expect(t.rows()!.length).toBe(1);
    // a picture sent alone is known again too: its echo is nothing but the [image] line
    t.own({ role: "user", text: "", images: ["data:image/png;base64,y"] }, ownSendKey(""));
    t.apply({ kind: "user", raw: "[image]", at: null });
    expect(t.rows()!.map((r) => r.text)).toEqual(["look", ""]);
  });

  test("the agent starting to speak counts as a change even before any words arrive", () => {
    const l = emptyLive();
    expect(applyEvent(l, delta("assistant_message", { content: "" })).changed).toBe(true);
    expect(l.lastRole).toBe("assistant");
  });

  test("the whole last reply, not the Inbox's digest of it", () => {
    const l = emptyLive();
    const long = "word ".repeat(400).trim();
    applyEvent(l, delta("assistant_message", { content: long }));
    expect(l.thread.lastReply()).toBe(long);
    applyEvent(l, { type: "turn_finished", runtime: rt });
    expect(l.thread.lastReply()).toBe(long);
    expect(l.lastAssistantText!.length).toBe(700);
  });
});

describe("slash command rows", () => {
  test("commandIdOf reads the command however the line was written", () => {
    expect(commandIdOf("/reload")).toBe("reload");
    expect(commandIdOf("reload")).toBe("reload");
    expect(commandIdOf("/compact all")).toBe("compact");
    expect(commandIdOf("  /Reload ")).toBe("reload");
  });
  const at = "2026-09-23T09:00:00.000Z";
  test("a row the harness began with its own wording is finished by the app's: no second row, nothing left running", () => {
    const t = new ThreadModel();
    t.beginCommand("reload", at); // slash_command_start, the harness's text
    expect(t.commandRunning("/reload")).toBe(true);
    t.finishCommand("/reload", true, "reloaded", at); // the app's own answer path
    expect(t.rows()).toHaveLength(1);
    expect(t.rows()![0].summary).toBe("reloaded");
    expect(t.commandRunning("/reload")).toBe(false);
  });
  test("the newest running row of that command is the one finished; an unrelated command is not touched", () => {
    const t = new ThreadModel();
    t.beginCommand("/compact all", at);
    t.beginCommand("/reload", at);
    t.finishCommand("/reload", true, "done", at);
    expect(t.rows()!.map((r) => r.summary)).toEqual(["running…", "done"]);
  });
  test("settleCommands after the link came back: /reload is the success case, anything else failed; nothing running is a no-op", () => {
    const t = new ThreadModel();
    t.beginCommand("reload", at);
    t.beginCommand("/compact", at);
    expect(t.settleCommands()).toBe(true);
    expect(t.rows()![0].summary).toMatch(/^reloaded/);
    expect(t.rows()![1].summary).toBe("failed");
    expect(t.rows()![1].detail).toMatch(/link.*dropped/);
    expect(t.settleCommands()).toBe(false);
  });
  test("slash_command_start / _end deltas become one event row: running, then the outcome", () => {
    const l = emptyLive();
    const d = (x: Record<string, unknown>) => ({ type: "stream_delta", delta: x });
    applyEvent(l, d({ message_type: "slash_command_start", command_id: "reload", input: "/reload" }));
    expect(l.thread.rows()).toMatchObject([{ role: "event", text: "/reload", summary: "running…" }]);
    applyEvent(l, d({ message_type: "slash_command_end", command_id: "reload", input: "/reload", output: "Reloaded 2 mods.", success: true }));
    expect(l.thread.rows()).toMatchObject([{ role: "event", text: "/reload", summary: "Reloaded 2 mods.", detail: null }]);
    // A long output goes behind the disclosure; a failure says so.
    applyEvent(l, d({ message_type: "slash_command_start", command_id: "compact", input: "/compact all" }));
    applyEvent(l, d({ message_type: "slash_command_end", command_id: "compact", input: "/compact all", output: "line one\nline two", success: false }));
    expect(l.thread.rows()![1]).toMatchObject({ role: "event", text: "/compact all", summary: "failed", detail: "line one\nline two" });
    // An end without a start still lands as a row.
    applyEvent(l, d({ message_type: "slash_command_end", command_id: "clear", input: "/clear", output: "Cleared.", success: true }));
    expect(l.thread.rows()![2]).toMatchObject({ role: "event", text: "/clear", summary: "Cleared.", detail: null });
  });
});

describe("a history page arriving", () => {
  const t1001 = "2026-10-09T10:01:00.000Z";
  const t1002 = "2026-10-09T10:02:00.000Z";
  const t1003 = "2026-10-09T10:03:00.000Z";
  const call7 = { role: "tool" as const, text: "Bash · ls", tool: { name: "Bash", id: "c7", input: "ls" } };

  test("rows the page holds lend it their times and go; a row that arrived after the page's newest stays after it", () => {
    const t = new ThreadModel();
    t.apply({ kind: "call", name: "Bash", args: { command: "ls" }, id: "c7", at: t1001 });
    t.apply({ kind: "assistant", text: "a2", at: t1003 });
    t.load([{ role: "user", text: "u1", at: "2026-10-09T10:00:00.000Z" }, { role: "assistant", text: "a1", at: t1002 }, { ...call7, at: null }]);
    expect(t.rows()!.map((r) => [r.text, r.at])).toEqual([["u1", "2026-10-09T10:00:00.000Z"], ["a1", t1002], ["Bash · ls", t1001], ["a2", t1003]]);
  });

  test("a row Letta never echoes (the answers to a question) goes once the page is newer than it", () => {
    const t = new ThreadModel();
    t.own({ role: "user", text: "yes · ship it", at: t1001 });
    t.load([{ role: "assistant", text: "shipping", at: t1002 }]);
    expect(t.rows()!.map((r) => r.text)).toEqual(["shipping"]);
  });

  test("a queued message and a running command stay after the page, in order", () => {
    const t = new ThreadModel();
    t.beginCommand("/compact", t1001);
    t.queue({ role: "user", text: "and also", at: t1001 });
    t.load([{ role: "user", text: "and also", at: "2026-10-09T09:00:00.000Z" }, { role: "assistant", text: "a1", at: t1002 }]);
    expect(t.rows()!.map((r) => [r.text, r.queued === true])).toEqual([["and also", false], ["a1", false], ["/compact", false], ["and also", true]]);
  });

  test("a page with no times keeps only what is pending, and takes the times the thread knew", () => {
    const t = new ThreadModel();
    t.apply({ kind: "user", raw: "ok", at: t1001 });
    t.apply({ kind: "assistant", text: "unseen by the page", at: t1003 });
    t.queue({ role: "user", text: "later", at: t1003 });
    t.load([{ role: "user", text: "ok" }, { role: "assistant", text: "earlier" }]);
    expect(t.rows()!.map((r) => [r.text, r.at])).toEqual([["ok", t1001], ["earlier", undefined], ["later", t1003]]);
  });

  test("rows are paired from the end: an older repeat does not take the newest one's time; a second load keeps the times", () => {
    const t = new ThreadModel();
    t.apply({ kind: "user", raw: "ok", at: t1001 });
    t.apply({ kind: "assistant", text: "done", at: t1002 });
    t.load([{ role: "user", text: "ok" }, { role: "assistant", text: "earlier" }, { role: "user", text: "ok" }, { role: "assistant", text: "done" }]);
    expect(t.rows()!.map((r) => r.at)).toEqual([undefined, undefined, t1001, t1002]);
    t.load([{ role: "user", text: "ok" }, { role: "assistant", text: "done" }]);
    expect(t.rows()!.map((r) => r.at)).toEqual([t1001, t1002]);
    // a page's own time wins
    t.load([{ role: "user", text: "ok", at: "2026-10-09T09:59:59Z" }, { role: "assistant", text: "done" }]);
    expect(t.rows()!.map((r) => r.at)).toEqual(["2026-10-09T09:59:59Z", t1002]);
  });

  test("a message you repeat while the page is stale stays: it pairs only with a row newer than the last page", () => {
    const t = new ThreadModel();
    const page = [{ role: "user" as const, text: "yes", at: "2026-10-09T10:00:00.000Z" }, { role: "assistant" as const, text: "done A", at: "2026-10-09T10:00:05.000Z" }];
    t.load(page);
    t.own({ role: "user", text: "yes", at: "2026-10-09T10:05:00.000Z" }, "yes");
    t.load(page); // read before the log held the new "yes"
    expect(t.rows()!.map((r) => [r.text, r.at])).toEqual([["yes", "2026-10-09T10:00:00.000Z"], ["done A", "2026-10-09T10:00:05.000Z"], ["yes", "2026-10-09T10:05:00.000Z"]]);
    // once the log holds it, it pairs and goes
    t.load([...page, { role: "user", text: "yes", at: "2026-10-09T10:05:01.000Z" }]);
    expect(t.rows()!.map((r) => r.text)).toEqual(["yes", "done A", "yes"]);
  });

  test("a picture you sent pairs with the page's [image] row, whatever the sending device's clock says", () => {
    const t = new ThreadModel();
    t.own({ role: "user", text: "look", images: ["data:image/png;base64,x"], at: "2026-10-09T10:09:00.000Z" }, "look"); // a phone running ahead
    t.load([{ role: "user", text: "look\n[image]", at: "2026-10-09T10:00:00.000Z" }]);
    expect(t.rows()!.map((r) => r.text)).toEqual(["look\n[image]"]);
  });

  test("an approval that arrives after the page took its call belongs to that call", () => {
    const t = new ThreadModel();
    t.apply({ kind: "call", name: "Bash", args: { command: "ls" }, id: "c7", at: "2026-10-09T10:01:00.000Z" });
    t.load([{ ...call7, at: "2026-10-09T10:01:00.000Z" }]);
    t.apply({ kind: "approval", name: "Bash", args: { command: "ls" }, id: "approval-1", at: "2026-10-09T10:01:01.000Z" });
    expect(tools(t.rows()).length).toBe(1);
  });

  test("an empty page leaves the live rows alone; a result for a call the page took lands on the page's row", () => {
    const t = new ThreadModel();
    t.apply({ kind: "user", raw: "first message", at: t1001 });
    t.load([]);
    expect(t.rows()!.map((r) => r.text)).toEqual(["first message"]);
    t.apply({ kind: "call", name: "Bash", args: { command: "ls" }, id: "c7", at: t1001 });
    t.load([{ ...call7, at: t1002 }]);
    t.apply({ kind: "result", id: "c7", output: "a.ts", failed: false });
    expect(t.rows()).toMatchObject([{ text: "Bash · ls", tool: { output: "a.ts" } }]);
  });
});

describe("every source makes the same thread", () => {
  const report = '<attachment kind="file" local_path="/tmp/r.pdf" name="r.pdf" />';
  const dates = ["2026-10-09T10:00:00.000Z", "2026-10-09T10:00:01.000Z", "2026-10-09T10:00:02.000Z", "2026-10-09T10:00:03.000Z", "2026-10-09T10:00:04.000Z", "2026-10-09T10:00:05.000Z"];
  const args = '{"command":"rm -rf build","description":"Clean the build"}';
  const backend = mkdtempSync(join(tmpdir(), "loki-thread-"));
  afterEach(() => rmSync(backend, { recursive: true, force: true }));

  test("the local log, the app-server's history and the live stream fold to equal rows", () => {
    // The local backend's log.
    const dir = join(backend, "conversations", conversationDirName("conv-same"));
    mkdirSync(dir, { recursive: true });
    const lines = [
      { type: "message", timestamp: dates[0], message: { role: "user", content: [{ type: "text", text: `read this ${report}` }] } },
      { type: "message", timestamp: dates[1], message: { role: "assistant", content: [{ type: "text", text: "On it." }, { type: "toolCall", id: "c1", name: "Bash", arguments: JSON.parse(args) }] } },
      { type: "message", message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "permission denied" }], isError: true } },
      { type: "message", timestamp: dates[3], message: { role: "user", content: '<skill_content name="unslop">\n# Unslop\n</skill_content>' } },
      { type: "message", timestamp: dates[4], message: { role: "assistant", content: [{ type: "text", text: "Two parts," }, { type: "text", text: "one reply." }] } },
    ];
    writeFileSync(join(dir, "messages.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const fromLog = readLocalTranscriptPage("conv-same", null, 400, backend).rows;

    // Letta's message list for the same conversation.
    const fromHistory = foldSteps(historySteps([
      { message_type: "user_message", content: [{ type: "text", text: `read this ${report}` }], date: dates[0] },
      { message_type: "assistant_message", content: "On it.", date: dates[1] },
      { message_type: "tool_call_message", tool_call: { name: "Bash", arguments: args, tool_call_id: "c1" }, date: dates[1] },
      { message_type: "approval_request_message", tool_call: { name: "Bash", arguments: args, tool_call_id: "c1" }, date: dates[1] },
      { message_type: "tool_return_message", tool_call_id: "c1", tool_return: "permission denied", status: "error", date: dates[2] },
      { message_type: "user_message", content: '<skill_content name="unslop">\n# Unslop\n</skill_content>', date: dates[3] },
      { message_type: "assistant_message", content: [{ type: "text", text: "Two parts," }, { type: "text", text: "one reply." }], date: dates[4] },
    ]));

    // The same turn as it streams in, the reply in pieces.
    const l = emptyLive();
    applyEvent(l, delta("user_message", { content: [{ type: "text", text: `read this ${report}` }] }), dates[0]);
    applyEvent(l, delta("assistant_message", { content: "On " }), dates[1]);
    applyEvent(l, delta("assistant_message", { content: "it." }), dates[1]);
    applyEvent(l, delta("tool_call_message", { tool_call: { name: "Bash", arguments: args.slice(0, 12), tool_call_id: "c1" } }), dates[1]);
    applyEvent(l, delta("tool_call_message", { tool_call: { name: "Bash", arguments: args.slice(12), tool_call_id: "c1" } }), dates[1]);
    applyEvent(l, delta("approval_request_message", { tool_call: { name: "Bash", arguments: args, tool_call_id: "approval-1" } }), dates[1]);
    applyEvent(l, delta("tool_return_message", { tool_call_id: "c1", tool_return: "permission denied", status: "error" }), dates[2]);
    applyEvent(l, delta("user_message", { content: '<skill_content name="unslop">\n# Unslop\n</skill_content>' }), dates[3]);
    applyEvent(l, delta("assistant_message", { content: "Two parts,\none reply." }), dates[4]);
    applyEvent(l, { type: "turn_finished", runtime: rt }, dates[5]);
    const live = l.thread.rows();

    expect(fromHistory).toEqual(fromLog);
    expect(live).toEqual(fromLog);
    expect(fromLog.map((r) => `${r.role}:${r.text}`)).toEqual(["user:read this", "assistant:On it.", "tool:Bash · rm -rf build", "event:skill loaded", "assistant:Two parts,\none reply."]);
    expect(fromLog[0].files).toEqual([{ path: "/tmp/r.pdf", name: "r.pdf" }]);
    expect(fromLog[2].tool).toEqual({ name: "Bash", id: "c1", input: "rm -rf build", description: "Clean the build", output: "permission denied", failed: true });
  });
});

describe("rows keep their identity until they change", () => {
  test("live rows keep their identity between updates; a row that changed is a new object", () => {
    const l = emptyLive();
    applyEvent(l, delta("user_message", { content: "go" }), "2026-09-23T09:00:00.000Z");
    l.thread.beginCommand("/reload", "2026-09-23T09:00:01.000Z");
    applyEvent(l, delta("assistant_message", { content: "Let " }), "2026-09-23T09:00:02.000Z");
    const first = l.thread.rows()!;
    applyEvent(l, delta("assistant_message", { content: "me" }), "2026-09-23T09:00:03.000Z");
    const second = l.thread.rows()!;
    expect(second.length).toBe(3);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).not.toBe(first[2]);
    expect(second[2].text).toBe("Let me");
    expect(l.thread.rows()![2]).toBe(second[2]); // nothing new: the same streaming row
    // the command's row is finished in place: its snapshot is new, the others stay
    l.thread.finishCommand("/reload", true, "reloaded", "2026-09-23T09:00:04.000Z");
    const third = l.thread.rows()!;
    expect(third[0]).toBe(first[0]);
    expect(third[1]).not.toBe(first[1]);
    expect(third[1].summary).toBe("reloaded");
  });

  test("a result landing on a call makes only that row new; the page's rows stay the same objects", () => {
    const t = new ThreadModel();
    t.load([{ role: "user", text: "go", at: "2026-09-23T09:00:00.000Z" }]);
    t.apply({ kind: "call", name: "Read", args: { path: "a.ts" }, id: "r1", at: "2026-09-23T09:00:01.000Z" });
    t.apply({ kind: "call", name: "Read", args: { path: "b.ts" }, id: "r2", at: "2026-09-23T09:00:02.000Z" });
    const before = t.rows()!;
    t.apply({ kind: "result", id: "r1", output: "a", failed: false });
    const after = t.rows()!;
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[2]).toBe(before[2]);
  });
});
