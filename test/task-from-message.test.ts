import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Task } from "../core/frame-types.ts";
import type { TranscriptRow } from "../core/attention/transcript.ts";
import { chipState, fromMessage, messageKey, parseTaskSource, quoteBlock, quoteOf, sourceMetadata, taskSource, tasksByMessage, tasksForRow, titleFrom, type TaskSource } from "../core/task-source.ts";
import { createArgs, noteArgs, TaskStore } from "../mod/tasks.ts";
import { MessageTasks, addingFrom, type MessageTasksValue, type TaskApi } from "../app/src/tasks/messageTasks.tsx";
import { Transcript } from "../app/src/chat/Transcript.tsx";
import { bridgeWith, client, settled } from "./fixtures/frames.ts";

/**
 * Add task from a chat message: the task is stamped with the message (role, a hash of its text, its time, a quote),
 * links back to it from Tasks, and the message shows a chip with the task's state and its newest note.
 */

const reply = "Here's the plan:\n\n- migrate **staging** first\n- then prod";
const row: TranscriptRow = { role: "assistant", text: reply, at: "2026-10-15T09:00:00.000Z" };
const source: TaskSource = { origin: "message", role: "assistant", key: messageKey("assistant", reply), at: row.at!, quote: "Here's the plan: - migrate **staging** first - then prod" };

const task = (id: string, metadata: Record<string, string>, status = "open"): Task => ({ id, title: `title ${id}`, description: "", status, priority: 2, labels: [], assignee: null, createdAt: "", updatedAt: "", closedAt: status === "closed" ? "2026-10-15T10:00:00Z" : null, metadata });
const fromReply = (id: string, extra: Record<string, string> = {}, status = "open") => task(id, { by: "you", conversation: "c1", agentId: "a1", ...sourceMetadata(source), ...extra }, status);

describe("the source: which message a task came from", () => {
  test("a message is named by its role and its text's hash, the same however its edges or line endings read", () => {
    expect(messageKey("assistant", reply)).toMatch(/^[0-9a-f]{8}$/);
    expect(messageKey("assistant", `  ${reply.replace(/\n/g, "\r\n")}\n`)).toBe(messageKey("assistant", reply));
    expect(messageKey("user", reply)).not.toBe(messageKey("assistant", reply));
    expect(messageKey("assistant", `${reply}!`)).not.toBe(messageKey("assistant", reply));
  });

  test("the editor starts from the first line that says something, without markdown's marks", () => {
    expect(titleFrom(reply)).toBe("Here's the plan:");
    expect(titleFrom("\n## Fix the **login** bug\nmore")).toBe("Fix the login bug");
    expect(titleFrom("- see [the doc](https://x.y/z) for `bd`")).toBe("see the doc for bd");
    expect(titleFrom("x".repeat(300))).toHaveLength(120);
  });

  test("the description quotes the message; the kept quote is one plain line, as find in the thread reads it", () => {
    expect(quoteBlock("one\n\ntwo")).toBe("> one\n>\n> two");
    expect(quoteOf(reply)).toBe("Here's the plan: - migrate staging first - then prod");
    expect(quoteOf("a ".repeat(200))).toHaveLength(160);
  });

  test("the bridge takes a well-formed source only", () => {
    expect(parseTaskSource({ ...source })).toEqual(source);
    expect(parseTaskSource({ ...source, origin: "inbox" })).toBeUndefined();
    expect(parseTaskSource({ ...source, role: "tool" })).toBeUndefined();
    expect(parseTaskSource({ ...source, key: "../../etc" })).toBeUndefined();
    expect(parseTaskSource({ ...source, at: "yesterday", quote: "q".repeat(500) })).toMatchObject({ at: null, quote: expect.stringMatching(/^q{159}…$/) });
  });

  test("the stamp is kept on the task's metadata, beside who filed it and from where", () => {
    const args = createArgs({ title: "migrate staging", description: quoteBlock(reply), stamp: { by: "you", conversation: "c1", desk: "a1/c1", agentId: "a1", source } });
    const md = JSON.parse(args[args.indexOf("--metadata") + 1]);
    expect(md).toEqual({ by: "you", agentId: "a1", conversation: "c1", desk: "a1/c1", origin: "message", msgRole: "assistant", msgKey: source.key, msgAt: source.at, quote: source.quote });
    expect(taskSource(task("lk-1", md))).toMatchObject({ ...source, conversation: "c1", agentId: "a1" });
    expect(taskSource(task("lk-2", { by: "you" }))).toBeNull();
  });

  test("a task finds its message by the hash, or (the text read back differently) by role and time; other chats' tasks stay out", () => {
    const tasks = [fromReply("lk-1"), task("lk-2", { by: "you", conversation: "c2", ...sourceMetadata(source) }), task("lk-3", { by: "you", conversation: "c1" })];
    const byKey = tasksByMessage(tasks, "c1");
    expect(tasksForRow(byKey, row).map((t) => t.id)).toEqual(["lk-1"]);
    expect(tasksForRow(byKey, { ...row, text: `${reply} (edited)` }).map((t) => t.id)).toEqual(["lk-1"]);
    expect(tasksForRow(byKey, { ...row, text: "something else", at: "2026-10-15T09:05:00.000Z" })).toEqual([]);
    expect(tasksForRow(byKey, { ...row, role: "user" })).toEqual([]);
    expect(fromMessage(tasks[0], row)).toBe(true);
  });
});

describe("filing it", () => {
  test("task_create stamps the source as yours; a source with no conversation is dropped", async () => {
    const made: unknown[] = [];
    const store = { create: async (t: { stamp: unknown }) => (made.push(t.stamp), fromReply("lk-1")) } as unknown as TaskStore;
    const { bridge, broadcasts } = bridgeWith({ tasks: store });
    const c = client("d1");
    bridge.onMessage(c, { type: "task_create", requestId: "r1", title: "migrate staging", conversationId: "c1", agentId: "a1", desk: "a1/c1", source });
    bridge.onMessage(c, { type: "task_create", requestId: "r2", title: "loose", source });
    await settled();
    expect(made[0]).toMatchObject({ by: "you", conversation: "c1", agentId: "a1", source });
    expect((made[1] as { source?: unknown }).source).toBeUndefined();
    expect(broadcasts.at(-1)?.frame).toEqual({ type: "tasks_changed" });
  });

  test("a paired phone may file one from a message's long press, and read the list for the chips", async () => {
    const store = { create: async () => fromReply("lk-1"), list: async () => [fromReply("lk-1")] } as unknown as TaskStore;
    const { bridge } = bridgeWith({ tasks: store });
    const phone = { ...client("d1"), deviceId: "phone-1" };
    bridge.onMessage(phone, { type: "task_create", requestId: "r1", title: "migrate staging", conversationId: "c1", source });
    bridge.onMessage(phone, { type: "tasks_list", requestId: "r2", all: true });
    await settled();
    expect(phone.sent.map((m) => m.type)).toEqual(["task_created", "tasks"]);
  });

  test("an agent's comment is kept on the task as its newest note, for the chip", async () => {
    const calls: string[][] = [];
    const store = new TaskStore({
      dir: "/nonexistent",
      run: async (args) => {
        calls.push(args);
        return args[0] === "update" ? JSON.stringify([{ id: "lk-1", title: "t", status: "open", metadata: { lastNote: "staging done" } }]) : "";
      },
    });
    const [updated] = await store.comment("lk-1", "  staging done\n\nprod next  ");
    expect(calls[0]).toEqual(["comment", "lk-1", "staging done\n\nprod next"]);
    expect(calls[1]).toEqual(noteArgs("lk-1", "staging done\n\nprod next", new Date(calls[1][5].slice("lastNoteAt=".length))));
    expect(calls[1][3]).toBe("lastNote=staging done prod next");
    expect(updated.metadata.lastNote).toBe("staging done");
    await expect(store.comment("-rf", "x")).rejects.toThrow(/no task/);
  });
});

describe("where the editor starts", () => {
  test("Add task on a message files the whole message, titled by its first line", () => {
    expect(addingFrom(row)).toEqual({ key: source.key, role: "assistant", at: row.at, text: reply, origin: "message", title: "Here's the plan:" });
  });
  test("⌘⇧T files just the selected words, still linked to the whole message", () => {
    expect(addingFrom(row, "  migrate **staging** first ")).toEqual({ key: source.key, role: "assistant", at: row.at, text: "migrate **staging** first", origin: "selection", title: "migrate staging first" });
    // An empty selection is the whole message.
    expect(addingFrom(row, "   ")?.origin).toBe("message");
  });
  test("tool rows, events and empty messages take no task", () => {
    expect(addingFrom({ role: "tool", text: "ran ls" })).toBeNull();
    expect(addingFrom({ role: "event", text: "compacted" })).toBeNull();
    expect(addingFrom({ role: "user", text: "  " })).toBeNull();
  });
});

describe("the chip on the message", () => {
  const api: TaskApi = { tasks: null, create: async () => null, open: () => {}, confirm: () => {}, reopen: () => {} };
  const people = { user: { name: "You" }, assistant: { name: "friday" } };
  function thread(tasks: Task[], adding: MessageTasksValue["adding"] = null, rows: TranscriptRow[] = [row]) {
    const byKey = tasksByMessage(tasks, "c1");
    const ctx: MessageTasksValue = { conversationId: "c1", tasksFor: (r) => tasksForRow(byKey, r), adding, start: () => {}, setTitle: () => {}, cancel: () => {}, submit: async () => null, api: { ...api, tasks } };
    return renderToStaticMarkup(createElement(MessageTasks.Provider, { value: ctx }, createElement(Transcript, { rows, people })));
  }

  test("every finished message offers Add task, and carries its key for ⌘⇧T and Tasks' way back", () => {
    const out = thread([]);
    expect(out).toContain('aria-label="add task"');
    expect(out).toContain(`data-msg-key="${source.key}"`);
    expect(out).toContain('data-conversation="c1"');
    // Without tasks from the host, nothing of it shows.
    expect(renderToStaticMarkup(createElement(Transcript, { rows: [row], people }))).not.toContain("add task");
  });

  test("open: the agent's newest note; done?: Confirm and Reopen; done: ticked", () => {
    const open = thread([fromReply("lk-1")]);
    expect(open).toContain("task · open");
    expect(open).not.toContain("loki-msg-task-note");
    const noted = thread([fromReply("lk-1", { lastNote: "staging migrated, prod next" })]);
    expect(noted).toContain("staging migrated, prod next");
    const waiting = thread([fromReply("lk-1", { lastNote: "old", doneAsked: "prod migrated too", doneAskedBy: "friday" })]);
    expect(waiting).toContain("done? · waiting for you");
    expect(waiting).toContain("prod migrated too");
    expect(waiting).toContain(">confirm<");
    expect(waiting).toContain(">reopen<");
    const done = thread([fromReply("lk-1", {}, "closed")]);
    expect(done).toContain('data-state="done"');
    expect(done).toContain("✓");
    expect(done).not.toContain(">confirm<");
    expect([fromReply("a"), fromReply("b", { doneAsked: "yes" }), fromReply("c", {}, "closed")].map(chipState)).toEqual(["open", "waiting", "done"]);
  });

  test("a new list (an agent commented, then said done?) redraws the chip", () => {
    const before = thread([fromReply("lk-1")]);
    const after = thread([fromReply("lk-1", { lastNote: "half way" })]);
    const asked = thread([fromReply("lk-1", { lastNote: "half way", doneAsked: "yes" })]);
    expect(before).not.toContain("half way");
    expect(after).toContain("half way");
    expect(asked).toContain("done? · waiting for you");
  });

  test("the editor opens under the message it is adding to, with the title to start from and where it files from", () => {
    const out = thread([], { key: source.key, role: "assistant", at: row.at!, text: "migrate staging first", origin: "selection", title: "migrate staging first" });
    expect(out).toContain('aria-label="add a task from this message"');
    expect(out).toContain('value="migrate staging first"');
    expect(out).toContain("from the selected text");
    const other = thread([], { key: "00000000", role: "assistant", at: null, text: "x", origin: "message", title: "x" });
    expect(other).not.toContain("add a task from this message");
  });
});
