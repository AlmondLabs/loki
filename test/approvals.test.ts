import { describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, MemoryStorage } from "@earendil-works/pi-durable";
import { Approvals, asks, type PermissionMode } from "../daemon/approvals.ts";
import { askExtension } from "../daemon/ask.ts";
import { AgentStore } from "../daemon/kernel/index.ts";
import type { ChatEvent } from "../core/attention/model.ts";

const ctx = BACKGROUND_CONTEXT;

describe("the permission modes", () => {
  const table = (mode: PermissionMode) => ({
    read: asks(mode, "read", { path: "/work/a" }, { cwd: "/work" }),
    editInside: asks(mode, "edit", { path: "a.ts" }, { cwd: "/work" }),
    command: asks(mode, "bash", { command: "ls" }, { cwd: "/work" }),
    widget: asks(mode, "write", { path: "/home/x/.loki/widgets/c/w.json" }, { cwd: "/work", widgetsDir: "/home/x/.loki/widgets" }),
  });

  test("each mode asks as the app describes it, and loki's widget folder never asks", () => {
    expect(table("strict")).toEqual({ read: true, editInside: true, command: true, widget: false });
    expect(table("standard")).toEqual({ read: false, editInside: true, command: true, widget: false });
    expect(table("acceptEdits")).toEqual({ read: false, editInside: false, command: true, widget: false });
    expect(table("unrestricted")).toEqual({ read: false, editInside: false, command: false, widget: false });
  });

  test("a question card is never a permission, and a path that climbs out of the widget folder is not inside it", () => {
    expect(asks("strict", "AskUserQuestion", {}, {})).toBe(false);
    expect(asks("standard", "write", { path: "/home/x/.loki/widgets/../secrets" }, { widgetsDir: "/home/x/.loki/widgets" })).toBe(true);
  });
});

/** A store whose chats run through the gate, with a command tool and an edit tool that record their runs. */
async function setup(mode: PermissionMode) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const approvals = new Approvals();
  const pushed: ChatEvent[] = [];
  approvals.attach((_a, _c, events) => pushed.push(...events));
  const ran: string[] = [];
  const registry = createRegistry();
  registry.install(approvals.extension());
  registry.install(askExtension(approvals));
  registry.install(
    defineExtension({
      name: "tools",
      tools: ["bash", "write"].map((name) =>
        defineTool({ name, description: name, parameters: { type: "object", properties: { x: { type: "string" } } } as never, execute: async (args) => (ran.push(`${name}:${String((args as { x?: string }).x)}`), { content: [{ type: "text", text: "ok" }] }) }),
      ),
    }),
  );
  const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry }, ctx);
  await store.setAgent({ id: "agent-local-a", name: "Ada" }, ctx);
  const chat = await store.createChat("c", { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } } }, ctx);
  await store.updateChat("c", { mode }, ctx);
  const sent: string[] = [];
  const reply = (m: ReturnType<typeof fauxAssistantMessage>) => (c: { messages: unknown[] }) => (sent.push(JSON.stringify(c.messages)), m);
  return { faux, approvals, pushed, ran, store, chat, sent, reply };
}

const until = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
};

const approvalIds = (pushed: ChatEvent[]) => pushed.flatMap((e) => (e.kind === "approval" ? [e.requestId] : []));

describe("approvals in a chat", () => {
  test("a command waits for the person; allowed, it runs; the client following the chat sees the ask and the loop", async () => {
    const s = await setup("standard");
    try {
      s.faux.setResponses([s.reply(fauxAssistantMessage(fauxToolCall("bash", { x: "1" }, { id: "t1" }), { stopReason: "toolUse" })), s.reply(fauxAssistantMessage("done"))]);
      const run = (await s.chat.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      await until(() => approvalIds(s.pushed).length === 1);
      expect(s.ran).toEqual([]);
      expect(s.approvals.waitingIn("agent-local-a", "c")).toEqual([{ kind: "approval", requestId: "approval-t1", toolName: "bash", input: { x: "1" } }]);
      expect(s.pushed).toContainEqual({ kind: "loop", state: "approval" });
      expect(s.approvals.decide("approval-t1", true)).toBe(true);
      expect(s.approvals.decide("approval-t1", true)).toBe(false); // a second client's answer finds nothing waiting
      await run;
      expect(s.ran).toEqual(["bash:1"]);
      expect(s.approvals.waitingIn("agent-local-a", "c")).toEqual([]);
    } finally {
      await s.store.close(ctx);
    }
  });

  test("denied, the tool does not run and the model reads the person's reason", async () => {
    const s = await setup("standard");
    try {
      s.faux.setResponses([s.reply(fauxAssistantMessage(fauxToolCall("bash", { x: "rm" }, { id: "t1" }), { stopReason: "toolUse" })), s.reply(fauxAssistantMessage("ok, not doing that"))]);
      const run = (await s.chat.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      await until(() => approvalIds(s.pushed).length === 1);
      s.approvals.decide("approval-t1", false, "not on this machine");
      await run;
      expect(s.ran).toEqual([]);
      expect(s.sent[1]).toContain("not on this machine");
    } finally {
      await s.store.close(ctx);
    }
  });

  test("stopping the chat while an approval waits withdraws it", async () => {
    const s = await setup("strict");
    try {
      s.faux.setResponses([s.reply(fauxAssistantMessage(fauxToolCall("bash", { x: "1" }, { id: "t1" }), { stopReason: "toolUse" }))]);
      await s.chat.submit({ type: "input", content: "go" }, ctx);
      await until(() => approvalIds(s.pushed).length === 1);
      await s.chat.abort(ctx);
      expect(s.approvals.waitingIn("agent-local-a", "c")).toEqual([]);
      expect(s.ran).toEqual([]);
    } finally {
      await s.store.close(ctx);
    }
  });

  test("two calls in one reply each ask, and answering one leaves the other waiting", async () => {
    const s = await setup("standard");
    try {
      s.faux.setResponses([
        s.reply(fauxAssistantMessage([fauxToolCall("bash", { x: "a" }, { id: "t1" }), fauxToolCall("write", { x: "b" }, { id: "t2" })], { stopReason: "toolUse" })),
        s.reply(fauxAssistantMessage("both done")),
      ]);
      const run = (await s.chat.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      await until(() => approvalIds(s.pushed).length >= 1);
      s.approvals.decide(approvalIds(s.pushed)[0], true);
      await until(() => approvalIds(s.pushed).length === 2);
      expect(new Set(approvalIds(s.pushed))).toEqual(new Set(["approval-t1", "approval-t2"]));
      expect(s.approvals.waitingIn("agent-local-a", "c")).toHaveLength(1);
      s.approvals.decide(approvalIds(s.pushed)[1], true);
      await run;
      expect(s.ran.sort()).toEqual(["bash:a", "write:b"]);
    } finally {
      await s.store.close(ctx);
    }
  });

  test("unrestricted asks for nothing", async () => {
    const s = await setup("unrestricted");
    try {
      s.faux.setResponses([s.reply(fauxAssistantMessage(fauxToolCall("bash", { x: "1" }), { stopReason: "toolUse" })), s.reply(fauxAssistantMessage("done"))]);
      await (await s.chat.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      expect(s.ran).toEqual(["bash:1"]);
      expect(approvalIds(s.pushed)).toEqual([]);
    } finally {
      await s.store.close(ctx);
    }
  });

  test("a question card's answers reach the model as the tool's result", async () => {
    const s = await setup("strict");
    try {
      const input = { questions: [{ question: "Which colour?", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false }] };
      s.faux.setResponses([s.reply(fauxAssistantMessage(fauxToolCall("AskUserQuestion", input, { id: "q1" }), { stopReason: "toolUse" })), s.reply(fauxAssistantMessage("Blue it is"))]);
      const run = (await s.chat.submit({ type: "input", content: "pick" }, ctx)).wait(ctx);
      await until(() => s.pushed.some((e) => e.kind === "question"));
      expect(s.pushed.find((e) => e.kind === "question")).toEqual({ kind: "question", requestId: "question-q1", input });
      expect(s.approvals.answer("question-q1", { ...input, answers: { "Which colour?": "Blue" } })).toBe(true);
      await run;
      expect(s.sent[1]).toContain('\\"Which colour?\\": Blue');
    } finally {
      await s.store.close(ctx);
    }
  });
});
