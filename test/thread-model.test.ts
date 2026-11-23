import { describe, expect, test } from "vitest";
import { applyChatEvent, chatStatusOf, emptyLive } from "../core/attention/model.ts";
import { commandIdOf, foldSteps, ownSendKey, ThreadModel, type HistoryRow } from "../core/attention/thread.ts";
import { leanPage, LEAN_DETAIL_MAX, LEAN_LINE_MAX, type TranscriptRow } from "../core/attention/transcript.ts";
import { suggestedMark } from "../core/harness.ts";
import { answerBlock } from "../core/advisor.ts";
import { approval, call, piece, push, result, said, user } from "./fixtures/chat-events.ts";
import { must } from "./fixtures/must.ts";

const at0 = "2026-09-05T08:00:00Z";
const tools = (rows: TranscriptRow[] | undefined) => (rows ?? []).filter((r) => r.role === "tool");
const rowsOf = (thread: ThreadModel) => must(thread.rows(), "the thread's rows");

describe("history as a thread", () => {
  test("history steps fold into a readable thread: markup stripped, machinery as events", () => {
    const t = foldSteps([
      user("<system-reminder>x</system-reminder>go", at0),
      call("Bash", null, undefined, at0),
      user("<task-notification><task-id>b1</task-id><status>completed</status><summary>ran</summary><result>a &gt; b</result></task-notification>", at0),
      said("Done.", at0),
    ]);
    expect(t.map((m) => `${m.role}:${m.text}`)).toEqual(["user:go", "tool:Bash", "event:background task b1 completed", "assistant:Done."]);
    expect(t[2]).toMatchObject({ summary: "ran", detail: "a > b" });
  });

  test("an old chat from Tasks' time reads cleanly: no <loki-tasks> markup, and its task_create call is a tool row (plan 049, U6)", () => {
    const t = foldSteps([
      user(
        "rotate the creds\n\n<loki-tasks>\nTasks assigned to this conversation on the user's task list (1):\n- lk-a1  P1  rotate SSO creds\n</loki-tasks>",
        at0,
      ),
      call("task_create", "t1", { title: "update the runbook" }, at0),
      result("t1", '{"filed":"lk-b2"}'),
      said("Filed lk-b2.", at0),
    ]);
    expect(t.map((m) => `${m.role}:${m.text}`)).toEqual(["user:rotate the creds", "tool:task_create", "assistant:Filed lk-b2."]);
    expect(t.some((m) => m.text.includes("loki-tasks"))).toBe(false);
  });

  test("history with times yields rows with times; history without yields rows without", () => {
    expect(foldSteps([user("hi", "2026-09-23T08:00:00Z"), said("hello", "2026-09-23T08:00:05Z")])).toEqual([
      { role: "user", text: "hi", at: "2026-09-23T08:00:00Z" },
      { role: "assistant", text: "hello", at: "2026-09-23T08:00:05Z" },
    ]);
    const bare = foldSteps([said("hello")]);
    expect(bare).toEqual([{ role: "assistant", text: "hello" }]);
    expect("at" in bare[0]).toBe(false);
  });

  test("a call is paired with its return by id; its approval request with the same id is the same row", () => {
    const rows = foldSteps([call("Bash", "c1", '{"command":"ls"}'), approval("Bash", "c1", '{"command":"ls"}'), result("c1", "a.ts", true)]);
    expect(rows).toEqual([{ role: "tool", text: "Bash · ls", tool: { name: "Bash", id: "c1", input: "ls", output: "a.ts", failed: true, error: "a.ts" } }]);
  });
});

describe("one row per tool call", () => {
  test("live, an approval request with its own id, or none, belongs to the call it asks about", () => {
    const l = emptyLive();
    push(l, call("AskUserQuestion", "t1"));
    push(l, approval("AskUserQuestion", "approval-9"));
    push(l, approval("AskUserQuestion", null));
    expect(tools(l.thread.rows()).length).toBe(1);
    push(l, piece("and again"));
    push(l, call("AskUserQuestion", "t2"));
    expect(tools(l.thread.rows()).length).toBe(2);
  });

  test("a second call of the same tool straight after the first is its own row, and gets its own result", () => {
    const rows = foldSteps([
      call("Read", "r1", { path: "a.ts" }),
      call("Read", "r2", { path: "b.ts" }),
      { kind: "result", id: "r2", output: "b", failed: false },
      { kind: "result", id: "r1", output: "a", failed: false },
    ]);
    expect(rows.map((r) => [r.text, r.tool?.output])).toEqual([
      ["Read · a.ts", "a"],
      ["Read · b.ts", "b"],
    ]);
  });

  test("an approval with no open call is a call; once something was said after a call, it is no longer open", () => {
    expect(tools(foldSteps([approval("Bash", "p1")]))).toMatchObject([{ tool: { name: "Bash", id: "p1" } }]);
    const rows = foldSteps([call("Bash", "c1"), { kind: "assistant", text: "one more", at: null }, approval("Bash", "p2")]);
    expect(tools(rows).map((r) => r.tool?.id)).toEqual(["c1", "p2"]);
    expect(tools(foldSteps([call("Bash", "c1"), { kind: "result", id: "c1", output: "ok", failed: false }, approval("Bash", "p3")])).length).toBe(2);
  });

  test("live, the input fills in as it streams and the result lands on its row", () => {
    const l = emptyLive();
    push(l, call("Bash", "c1", '{"comm'), "2026-09-26T09:00:00Z");
    expect(rowsOf(l.thread)[0].tool).toEqual({ name: "Bash", id: "c1" });
    push(l, call("Bash", "c1", 'and":"ls"}'), "2026-09-26T09:00:01Z");
    expect(rowsOf(l.thread)[0]).toMatchObject({ text: "Bash · ls", tool: { input: "ls" } });
    push(l, result("c1", "a.ts"), "2026-09-26T09:00:02Z");
    expect(rowsOf(l.thread)[0].tool).toEqual({ name: "Bash", id: "c1", input: "ls", output: "a.ts" });
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
    push(l, user("hello"));
    expect(l.thread.rows()).toMatchObject([{ role: "user", text: "hello" }]);
    applyChatEvent(l, { kind: "loop", state: "running" });
    expect(chatStatusOf(l)).toBe("thinking");
    push(l, piece("Let me "));
    expect(chatStatusOf(l)).toBe("streaming");
    push(l, call("Bash", "t1"));
    push(l, call("Bash", "t1"));
    expect(l.thread.rows()).toMatchObject([
      { role: "user", text: "hello" },
      { role: "assistant", text: "Let me" },
      { role: "tool", text: "Bash" },
    ]);
    push(l, piece("done."));
    applyChatEvent(l, { kind: "loop", state: "idle" });
    expect(rowsOf(l.thread).at(-1)).toMatchObject({ role: "assistant", text: "done." });
    expect(l.lastAssistantText).toBe("done.");
    expect(chatStatusOf(l)).toBe("idle");
    push(l, user("from desktop"));
    expect(rowsOf(l.thread).at(-1)).toMatchObject({ role: "user", text: "from desktop" });
  });

  test("the desk block and a loaded skill become event rows; the user's own words stay a user row", () => {
    const l = emptyLive();
    push(l, user('build it\n\n<loki-desk desk="c">\n- moved "x" to (1, 2)\n</loki-desk>'));
    expect(l.thread.rows()).toMatchObject([
      { role: "event", text: "canvas activity", summary: "1 gesture on c", detail: 'moved "x" to (1, 2)' },
      { role: "user", text: "build it" },
    ]);
    const r = push(l, user('<skill_content name="unslop">\n# Unslop\n</skill_content>'));
    expect(r).toEqual({ changed: true, userSpoke: false });
    expect(rowsOf(l.thread)[2]).toMatchObject({ role: "event", text: "skill loaded", summary: "unslop", detail: "# Unslop" });
  });

  test("user, tool, event and settled assistant rows carry the time they arrived; the reply keeps the time it started", () => {
    const l = emptyLive();
    push(l, user("go"), "2026-09-23T09:00:00.000Z");
    push(l, piece("Let "), "2026-09-23T09:00:02.000Z");
    push(l, piece("me"), "2026-09-23T09:00:03.000Z");
    expect(rowsOf(l.thread).at(-1)).toMatchObject({ text: "Let me", at: "2026-09-23T09:00:02.000Z" });
    push(l, call("Bash", "t1"), "2026-09-23T09:00:04.000Z");
    l.thread.beginCommand("/reload", "2026-09-23T09:00:06.000Z");
    expect(rowsOf(l.thread).map((r) => [r.role, r.at])).toEqual([
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
    expect(rowsOf(t).length).toBe(1);
    t.own({ role: "user", text: "", images: ["data:image/png;base64,y"] }, ownSendKey(""));
    t.apply({ kind: "user", raw: "[image]", at: null });
    expect(rowsOf(t).map((r) => r.text)).toEqual(["look", ""]);
  });

  test("the agent starting to speak counts as a change even before any words arrive", () => {
    const l = emptyLive();
    expect(push(l, piece("")).changed).toBe(true);
    expect(l.lastRole).toBe("assistant");
  });

  test("the whole last reply, not the Inbox's digest of it", () => {
    const l = emptyLive();
    const long = "word ".repeat(400).trim();
    push(l, piece(long));
    expect(l.thread.lastReply()).toBe(long);
    applyChatEvent(l, { kind: "turn_end" });
    expect(l.thread.lastReply()).toBe(long);
    expect(must(l.lastAssistantText, "the last assistant text").length).toBe(700);
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
    t.beginCommand("reload", at);
    expect(t.commandRunning("/reload")).toBe(true);
    t.finishCommand("/reload", true, "reloaded", at);
    expect(t.rows()).toHaveLength(1);
    expect(rowsOf(t)[0].summary).toBe("reloaded");
    expect(t.commandRunning("/reload")).toBe(false);
  });
  test("the newest running row of that command is the one finished; an unrelated command is not touched", () => {
    const t = new ThreadModel();
    t.beginCommand("/compact all", at);
    t.beginCommand("/reload", at);
    t.finishCommand("/reload", true, "done", at);
    expect(rowsOf(t).map((r) => r.summary)).toEqual(["running…", "done"]);
  });
  test("settleCommands after the link came back: /reload is the success case, anything else failed; nothing running is a no-op", () => {
    const t = new ThreadModel();
    t.beginCommand("reload", at);
    t.beginCommand("/compact", at);
    expect(t.settleCommands()).toBe(true);
    expect(rowsOf(t)[0].summary).toMatch(/^reloaded/);
    expect(rowsOf(t)[1].summary).toBe("failed");
    expect(rowsOf(t)[1].detail).toMatch(/link.*dropped/);
    expect(t.settleCommands()).toBe(false);
  });
  test("a command's start and end events become one event row: running, then the outcome", () => {
    const l = emptyLive();
    applyChatEvent(l, { kind: "command", phase: "start", input: "/reload" });
    expect(l.thread.rows()).toMatchObject([{ role: "event", text: "/reload", summary: "running…" }]);
    applyChatEvent(l, { kind: "command", phase: "end", input: "/reload", output: "Reloaded 2 mods.", success: true });
    expect(l.thread.rows()).toMatchObject([{ role: "event", text: "/reload", summary: "Reloaded 2 mods.", detail: null }]);
    applyChatEvent(l, { kind: "command", phase: "start", input: "/compact all" });
    applyChatEvent(l, { kind: "command", phase: "end", input: "/compact all", output: "line one\nline two", success: false });
    expect(rowsOf(l.thread)[1]).toMatchObject({ role: "event", text: "/compact all", summary: "failed", detail: "line one\nline two" });
    applyChatEvent(l, { kind: "command", phase: "start", input: "/doctor" });
    applyChatEvent(l, { kind: "command", phase: "end", input: "/doctor", output: "a memory review of this agent is already running", success: false });
    expect(rowsOf(l.thread).find((r) => r.text === "/doctor")).toMatchObject({
      summary: "failed: a memory review of this agent is already running",
      detail: null,
    });
    applyChatEvent(l, { kind: "command", phase: "end", input: "/clear", output: "Cleared.", success: true });
    expect(rowsOf(l.thread).find((r) => r.text === "/clear")).toMatchObject({ role: "event", text: "/clear", summary: "Cleared.", detail: null });
  });
});

describe("pages by position (plan 033)", () => {
  const thread = (n: number): HistoryRow[] =>
    Array.from({ length: n }, (_, i) =>
      i % 5 === 4
        ? {
            role: "tool" as const,
            text: `Read · ${i}`,
            tool: { name: "Read", id: `t${i}`, input: `${i}.ts` },
            at: `2026-10-25T09:${String(i % 60).padStart(2, "0")}:00.000Z`,
          }
        : { role: i % 2 ? ("assistant" as const) : ("user" as const), text: `row ${i}`, at: `2026-10-25T09:${String(i % 60).padStart(2, "0")}:00.000Z` },
    );
  const texts = (t: ThreadModel) => rowsOf(t).map((r) => r.text);

  test("an older page goes in front, and the rows since the last page stay after it", () => {
    const all = thread(30);
    const t = new ThreadModel();
    t.load(all.slice(20), 20);
    t.own({ role: "user", text: "just sent", at: "2026-10-25T10:00:00.000Z" }, "just sent");
    expect(t.firstPosition).toBe(20);
    t.prepend(all.slice(10, 20), 10);
    expect(t.firstPosition).toBe(10);
    t.prepend(all.slice(0, 10), 0);
    expect(t.firstPosition).toBe(0);
    expect(texts(t)).toEqual([...all.map((r) => r.text), "just sent"]);
  });

  test("a page that overlaps what is loaded adds only the rows before it", () => {
    const all = thread(20);
    const t = new ThreadModel();
    t.load(all.slice(10), 10);
    t.prepend(all.slice(5, 15), 5);
    expect(texts(t)).toEqual(all.slice(5).map((r) => r.text));
  });

  test("opening again: the newest page keeps the older pages in front, and unchanged rows keep their objects", () => {
    const all = thread(30);
    const t = new ThreadModel();
    t.load(all.slice(20), 20);
    t.prepend(all.slice(10, 20), 10);
    const was = rowsOf(t);
    const now = [...thread(32)];
    now[24] = { ...now[24], tool: { name: "Read", id: "t24", input: "24.ts", output: "done" } };
    t.load(now.slice(22), 22);
    const after = rowsOf(t);
    expect(after.map((r) => r.text)).toEqual(now.slice(10).map((r) => r.text));
    expect(t.firstPosition).toBe(10);
    for (const i of [10, 15, 22, 23, 29]) expect(after[i - 10], `row ${i}`).toBe(was[i - 10]);
    expect(after[24 - 10]).not.toBe(was[24 - 10]);
    expect(after[24 - 10].tool?.output).toBe("done");
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
    t.load(
      [
        { role: "user", text: "u1", at: "2026-10-09T10:00:00.000Z" },
        { role: "assistant", text: "a1", at: t1002 },
        { ...call7, at: null },
      ],
      0,
    );
    expect(rowsOf(t).map((r) => [r.text, r.at])).toEqual([
      ["u1", "2026-10-09T10:00:00.000Z"],
      ["a1", t1002],
      ["Bash · ls", t1001],
      ["a2", t1003],
    ]);
  });

  test("a row the daemon never echoes (the answers to a question) goes once the page is newer than it", () => {
    const t = new ThreadModel();
    t.own({ role: "user", text: "yes · ship it", at: t1001 });
    t.load([{ role: "assistant", text: "shipping", at: t1002 }], 0);
    expect(rowsOf(t).map((r) => r.text)).toEqual(["shipping"]);
  });

  test("a queued message and a running command stay after the page, in order", () => {
    const t = new ThreadModel();
    t.beginCommand("/compact", t1001);
    t.queue({ role: "user", text: "and also", at: t1001 });
    t.load(
      [
        { role: "user", text: "and also", at: "2026-10-09T09:00:00.000Z" },
        { role: "assistant", text: "a1", at: t1002 },
      ],
      0,
    );
    expect(rowsOf(t).map((r) => [r.text, r.queued === true])).toEqual([
      ["and also", false],
      ["a1", false],
      ["/compact", false],
      ["and also", true],
    ]);
  });

  test("a page with no times keeps only what is pending, and takes the times the thread knew", () => {
    const t = new ThreadModel();
    t.apply({ kind: "user", raw: "ok", at: t1001 });
    t.apply({ kind: "assistant", text: "unseen by the page", at: t1003 });
    t.queue({ role: "user", text: "later", at: t1003 });
    t.load(
      [
        { role: "user", text: "ok" },
        { role: "assistant", text: "earlier" },
      ],
      0,
    );
    expect(rowsOf(t).map((r) => [r.text, r.at])).toEqual([
      ["ok", t1001],
      ["earlier", undefined],
      ["later", t1003],
    ]);
  });

  test("rows are paired from the end: an older repeat does not take the newest one's time; a second load keeps the times", () => {
    const t = new ThreadModel();
    t.apply({ kind: "user", raw: "ok", at: t1001 });
    t.apply({ kind: "assistant", text: "done", at: t1002 });
    t.load(
      [
        { role: "user", text: "ok" },
        { role: "assistant", text: "earlier" },
        { role: "user", text: "ok" },
        { role: "assistant", text: "done" },
      ],
      0,
    );
    expect(rowsOf(t).map((r) => r.at)).toEqual([undefined, undefined, t1001, t1002]);
    t.load(
      [
        { role: "user", text: "ok" },
        { role: "assistant", text: "done" },
      ],
      0,
    );
    expect(rowsOf(t).map((r) => r.at)).toEqual([t1001, t1002]);
    t.load(
      [
        { role: "user", text: "ok", at: "2026-10-09T09:59:59Z" },
        { role: "assistant", text: "done" },
      ],
      0,
    );
    expect(rowsOf(t).map((r) => r.at)).toEqual(["2026-10-09T09:59:59Z", t1002]);
  });

  test("a message you repeat while the page is stale stays: it pairs only with a row newer than the last page", () => {
    const t = new ThreadModel();
    const page = [
      { role: "user" as const, text: "yes", at: "2026-10-09T10:00:00.000Z" },
      { role: "assistant" as const, text: "done A", at: "2026-10-09T10:00:05.000Z" },
    ];
    t.load(page, 0);
    t.own({ role: "user", text: "yes", at: "2026-10-09T10:05:00.000Z" }, "yes");
    t.load(page, 0);
    expect(rowsOf(t).map((r) => [r.text, r.at])).toEqual([
      ["yes", "2026-10-09T10:00:00.000Z"],
      ["done A", "2026-10-09T10:00:05.000Z"],
      ["yes", "2026-10-09T10:05:00.000Z"],
    ]);
    t.load([...page, { role: "user", text: "yes", at: "2026-10-09T10:05:01.000Z" }], 0);
    expect(rowsOf(t).map((r) => r.text)).toEqual(["yes", "done A", "yes"]);
  });

  test("a picture you sent pairs with the page's [image] row, whatever the sending device's clock says", () => {
    const t = new ThreadModel();
    t.own({ role: "user", text: "look", images: ["data:image/png;base64,x"], at: "2026-10-09T10:09:00.000Z" }, "look");
    t.load([{ role: "user", text: "look\n[image]", at: "2026-10-09T10:00:00.000Z" }], 0);
    expect(rowsOf(t).map((r) => r.text)).toEqual(["look\n[image]"]);
  });

  test("an approval that arrives after the page took its call belongs to that call", () => {
    const t = new ThreadModel();
    t.apply({ kind: "call", name: "Bash", args: { command: "ls" }, id: "c7", at: "2026-10-09T10:01:00.000Z" });
    t.load([{ ...call7, at: "2026-10-09T10:01:00.000Z" }], 0);
    t.apply({ kind: "approval", name: "Bash", args: { command: "ls" }, id: "approval-1", at: "2026-10-09T10:01:01.000Z" });
    expect(tools(t.rows()).length).toBe(1);
  });

  test("an empty page leaves the live rows alone; a result for a call the page took lands on the page's row", () => {
    const t = new ThreadModel();
    t.apply({ kind: "user", raw: "first message", at: t1001 });
    t.load([], 0);
    expect(rowsOf(t).map((r) => r.text)).toEqual(["first message"]);
    t.apply({ kind: "call", name: "Bash", args: { command: "ls" }, id: "c7", at: t1001 });
    t.load([{ ...call7, at: t1002 }], 0);
    t.apply({ kind: "result", id: "c7", output: "a.ts", failed: false });
    expect(t.rows()).toMatchObject([{ text: "Bash · ls", tool: { output: "a.ts" } }]);
  });
});

describe("a message sent from a suggestion (plan 049, KTD6)", () => {
  const sent = `${suggestedMark({ from_agent: "friday", from_chat: "data", title: "Fix the flaky upload test" })}\n\nThe upload test sleeps.`;
  const chip = {
    role: "event",
    text: "suggested in another chat",
    summary: "Fix the flaky upload test",
    link: { agent_id: "friday", conversation_id: "data" },
  };

  test("live, its event row links back to the chat the suggestion was made in", () => {
    const l = emptyLive();
    push(l, user(sent));
    expect(l.thread.rows()).toMatchObject([chip, { role: "user", text: "The upload test sleeps." }]);
  });

  test("from a history page, the reloaded row keeps the link", () => {
    const page: HistoryRow[] = leanPage(foldSteps([user(sent, at0), said("On it.", at0)]), 0);
    const t = new ThreadModel();
    t.load(page, 0);
    expect(rowsOf(t)).toMatchObject([chip, { role: "user", text: "The upload test sleeps." }, { role: "assistant", text: "On it." }]);
  });

  test("no other event row carries a link", () => {
    expect(foldSteps([user('<skill_content name="unslop">\n# Unslop\n</skill_content>')])[0]).not.toHaveProperty("link");
  });
});

describe("an advisor's answer (R16, R24)", () => {
  const long = `The test sleeps.\n\nIt waits for a lock.\nThe CI box is slower.\n\n${"More detail. ".repeat(100).trim()}`;
  const answered = answerBlock({ from: "person", asked: "Is it flaky?", advisor_chat: "advisor-data", state: "answered", text: long });
  const row = {
    role: "event",
    text: "From the advisor · you asked",
    summary: "The test sleeps.\nIt waits for a lock.\nThe CI box is slower.…",
    advisor_chat: "advisor-data",
  };

  test("live, it is a row of its own from the advisor, and the person's words beside it are their bubble", () => {
    const l = emptyLive();
    push(l, user(`${answered}\n\nThen fix it.`));
    expect(l.thread.rows()).toMatchObject([
      { ...row, detail: long },
      { role: "user", text: "Then fix it." },
    ]);
    expect(l.thread.rows()).toHaveLength(2);
  });

  test("alone, it leaves no bubble of the person's", () => {
    const l = emptyLive();
    push(l, user(answered));
    expect(l.thread.rows()).toMatchObject([row]);
    expect(l.thread.rows()).toHaveLength(1);
  });

  test("from a history page, the reloaded row keeps its advisor chat and loads its whole answer later", () => {
    const page: HistoryRow[] = leanPage(foldSteps([user(answered, at0), said("Fixed.", at0)]), 0);
    const t = new ThreadModel();
    t.load(page, 0);
    expect(rowsOf(t)).toMatchObject([
      { ...row, detail: null, row: 0 },
      { role: "assistant", text: "Fixed." },
    ]);
  });

  test("a consult that ended without an answer is a row with the reason", () => {
    const failed = answerBlock({ from: "agent", asked: "Is it flaky?", advisor_chat: "advisor-data", state: "stopped", reason: "it was stopped" });
    expect(foldSteps([user(failed)])).toEqual([
      {
        role: "event",
        text: "From the advisor · the agent asked",
        summary: "The advisor couldn't answer: it was stopped",
        detail: null,
        advisor_chat: "advisor-data",
      },
    ]);
  });
});

describe("every source makes the same thread", () => {
  const report = '<attachment kind="file" local_path="/tmp/r.pdf" name="r.pdf" />';
  const dates = [
    "2026-10-09T10:00:00.000Z",
    "2026-10-09T10:00:01.000Z",
    "2026-10-09T10:00:02.000Z",
    "2026-10-09T10:00:03.000Z",
    "2026-10-09T10:00:04.000Z",
    "2026-10-09T10:00:05.000Z",
  ];
  const args = '{"command":"rm -rf build","description":"Clean the build"}';

  test("the history and the live stream fold to equal rows", () => {
    const fromHistory = foldSteps([
      user(`read this ${report}`, dates[0]),
      said("On it.", dates[1]),
      call("Bash", "c1", args, dates[1]),
      approval("Bash", "c1", args, dates[1]),
      result("c1", "permission denied", true),
      user('<skill_content name="unslop">\n# Unslop\n</skill_content>', dates[3]),
      said("Two parts,\none reply.", dates[4]),
    ]);

    const l = emptyLive();
    push(l, user(`read this ${report}`), dates[0]);
    push(l, piece("On "), dates[1]);
    push(l, piece("it."), dates[1]);
    push(l, call("Bash", "c1", args.slice(0, 12)), dates[1]);
    push(l, call("Bash", "c1", args.slice(12)), dates[1]);
    push(l, approval("Bash", "approval-1", args), dates[1]);
    push(l, result("c1", "permission denied", true), dates[2]);
    push(l, user('<skill_content name="unslop">\n# Unslop\n</skill_content>'), dates[3]);
    push(l, piece("Two parts,\none reply."), dates[4]);
    applyChatEvent(l, { kind: "turn_end" }, dates[5]);
    const live = l.thread.rows();

    expect(live).toEqual(fromHistory);
    expect(fromHistory.map((r) => `${r.role}:${r.text}`)).toEqual([
      "user:read this",
      "assistant:On it.",
      "tool:Bash · rm -rf build",
      "event:skill loaded",
      "assistant:Two parts,\none reply.",
    ]);
    expect(fromHistory[0].files).toEqual([{ path: "/tmp/r.pdf", name: "r.pdf" }]);
    expect(fromHistory[2].tool).toEqual({
      name: "Bash",
      id: "c1",
      input: "rm -rf build",
      description: "Clean the build",
      output: "permission denied",
      failed: true,
      error: "permission denied",
    });
  });
});

describe("rows keep their identity until they change", () => {
  test("live rows keep their identity between updates; a row that changed is a new object", () => {
    const l = emptyLive();
    push(l, user("go"), "2026-09-23T09:00:00.000Z");
    l.thread.beginCommand("/reload", "2026-09-23T09:00:01.000Z");
    push(l, piece("Let "), "2026-09-23T09:00:02.000Z");
    const first = rowsOf(l.thread);
    push(l, piece("me"), "2026-09-23T09:00:03.000Z");
    const second = rowsOf(l.thread);
    expect(second.length).toBe(3);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).not.toBe(first[2]);
    expect(second[2].text).toBe("Let me");
    expect(rowsOf(l.thread)[2]).toBe(second[2]);
    l.thread.finishCommand("/reload", true, "reloaded", "2026-09-23T09:00:04.000Z");
    const third = rowsOf(l.thread);
    expect(third[0]).toBe(first[0]);
    expect(third[1]).not.toBe(first[1]);
    expect(third[1].summary).toBe("reloaded");
  });

  test("the rows are one array until something changes, and a new one after each kind of change", () => {
    const t = new ThreadModel();
    expect(t.rows()).toBeUndefined();
    t.load([{ role: "user", text: "go", at: "2026-09-23T09:00:00.000Z" }], 0);
    const loaded = rowsOf(t);
    expect(rowsOf(t)).toBe(loaded);
    const changes: Array<[string, () => void]> = [
      ["a streamed piece", () => t.apply({ kind: "assistant", text: "Let ", at: "2026-09-23T09:00:01.000Z", chunk: true })],
      ["another piece", () => t.apply({ kind: "assistant", text: "me", at: null, chunk: true })],
      ["a call, which settles the reply", () => t.apply({ kind: "call", name: "Read", args: { path: "a.ts" }, id: "r1", at: "2026-09-23T09:00:02.000Z" })],
      ["its result", () => t.apply({ kind: "result", id: "r1", output: "a", failed: false })],
      [
        "a page",
        () =>
          t.load(
            [
              { role: "user", text: "go", at: "2026-09-23T09:00:00.000Z" },
              { role: "assistant", text: "Let me", at: "2026-09-23T09:00:01.000Z" },
            ],
            0,
          ),
      ],
      [
        "a result onto the page's call",
        () => (
          t.load([{ role: "tool", text: "Read", tool: { name: "Read", id: "r2" } }], 0),
          t.apply({ kind: "result", id: "r2", output: "b", failed: false })
        ),
      ],
    ];
    let before = rowsOf(t);
    for (const [what, change] of changes) {
      change();
      const after = rowsOf(t);
      expect(after, what).not.toBe(before);
      expect(rowsOf(t), `${what}, read again`).toBe(after);
      before = after;
    }
    t.apply({ kind: "assistant", text: "", at: null, chunk: true });
    expect(rowsOf(t)).toBe(before);
  });

  test("a result landing on a call makes only that row new; the page's rows stay the same objects", () => {
    const t = new ThreadModel();
    t.load([{ role: "user", text: "go", at: "2026-09-23T09:00:00.000Z" }], 0);
    t.apply({ kind: "call", name: "Read", args: { path: "a.ts" }, id: "r1", at: "2026-09-23T09:00:01.000Z" });
    t.apply({ kind: "call", name: "Read", args: { path: "b.ts" }, id: "r2", at: "2026-09-23T09:00:02.000Z" });
    const before = rowsOf(t);
    t.apply({ kind: "result", id: "r1", output: "a", failed: false });
    const after = rowsOf(t);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[2]).toBe(before[2]);
  });

  test("a history page sends finished tool rows lean, with their position; a call still waiting and every other row go whole (plan 041)", () => {
    const long = `cd /repo && ${"grep -rn thing ".repeat(40)}\nsecond line`;
    const rows: TranscriptRow[] = [
      { role: "user", text: "look" },
      { role: "tool", text: long, tool: { name: long, id: "c1", input: long, output: "x".repeat(4000), description: "Search the repo" } },
      { role: "tool", text: "Bash · false", tool: { name: "Bash", id: "c2", input: "false", failed: true, error: "exit 1" } },
      { role: "tool", text: "Bash · sleep 9", tool: { name: "Bash", id: "c3", input: "sleep 9" } },
      { role: "event", text: "background task", detail: "the whole result" },
    ];
    const lean = leanPage(rows, 40);
    expect(lean[0]).toBe(rows[0]);
    expect(lean[1].tool).toEqual({ name: lean[1].text, id: "c1", description: "Search the repo", row: 41 });
    expect(lean[1].text.length).toBeLessThanOrEqual(LEAN_LINE_MAX + 1);
    expect(lean[1].text.endsWith("…")).toBe(true);
    expect(lean[2].tool).toEqual({ name: "Bash", id: "c2", failed: true, error: "exit 1", row: 42 });
    expect(lean[2].text).toBe("Bash · false");
    expect(lean[3]).toBe(rows[3]);
    expect(lean[4]).toBe(rows[4]);
  });
  test("a history page sends an event's long detail lean, with its position; a short one goes whole (plan 043)", () => {
    const rows: TranscriptRow[] = [
      { role: "event", text: "background task", summary: "done", detail: "x".repeat(LEAN_DETAIL_MAX + 1) },
      { role: "event", text: "skill loaded", summary: "plan", detail: "y".repeat(LEAN_DETAIL_MAX) },
      { role: "event", text: "moved to this Mac", summary: null, detail: null },
    ];
    const lean = leanPage(rows, 12);
    expect(lean[0]).toEqual({ role: "event", text: "background task", summary: "done", detail: null, row: 12 });
    expect(lean[1]).toBe(rows[1]);
    expect(lean[2]).toBe(rows[2]);
  });
  test("a lean row in a loaded page is a finished call: a live approval for that tool does not take it (plan 041)", () => {
    const t = new ThreadModel();
    t.load(leanPage([{ role: "tool", text: "Bash · ls", tool: { name: "Bash", id: "c1", input: "ls", output: "a\nb" } }], 0), 0);
    t.apply({ kind: "approval", name: "Bash", args: { command: "rm x" }, id: "p2", at: null });
    const shown = tools(t.rows());
    expect(shown).toHaveLength(2);
    expect(shown[0].tool).toMatchObject({ id: "c1", row: 0 });
    expect(shown[1].tool).toMatchObject({ name: "Bash", id: "p2" });
  });
});
