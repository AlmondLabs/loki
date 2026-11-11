import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, MemoryStorage } from "@earendil-works/pi-durable";
import { Approvals, asks, type PermissionMode } from "../daemon/approvals.ts";
import { askExtension } from "../daemon/ask.ts";
import { AgentStore } from "../daemon/kernel/index.ts";
import { subagentExtension } from "../daemon/subagents.ts";
import { offersAlways, type ChatEvent } from "../core/attention/model.ts";
import { scriptExtensions, scriptSandbox } from "../daemon/scripts.ts";

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
    expect(asks("strict", "user_ask", {}, {})).toBe(false);
    // A suggestion is already the person's decision (plan 049, KTD4): finding chats and suggesting never ask, strict included.
    for (const name of ["chat_list", "suggestion_create", "suggestion_list", "suggestion_withdraw"]) expect(asks("strict", name, {}, {})).toBe(false);
    // A chat message asks on its own link card (plan 067), which no mode stands in for.
    expect(asks("strict", "chat_message", {}, {})).toBe(false);
    expect(asks("standard", "write", { path: "/home/x/.loki/widgets/../secrets" }, { widgetsDir: "/home/x/.loki/widgets" })).toBe(true);
  });
});

/**
 * A store whose chats run through the gate, with a command tool and an edit tool that record their runs; `helpers`
 * adds the subagent tool, kinded as the daemon kinds it, and a folder for the chat.
 */
async function setup(mode: PermissionMode, opts: { alwaysPath?: string; helpers?: boolean } = {}) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const approvals = new Approvals({
    ...(opts.alwaysPath ? { alwaysPath: opts.alwaysPath } : {}),
    ...(opts.helpers ? { kindOfTool: (name: string) => (name === "subagent" ? "read" : name === "write" ? "edit" : "command") } : {}),
  });
  const pushed: ChatEvent[] = [];
  approvals.attach((_a, _c, events) => pushed.push(...events));
  const ran: string[] = [];
  const registry = createRegistry();
  registry.install(approvals.extension());
  registry.install(askExtension(approvals));
  if (opts.helpers) registry.install(subagentExtension());
  registry.install(
    defineExtension({
      name: "tools",
      tools: ["bash", "write"].map((name) =>
        defineTool({
          name,
          description: name,
          parameters: { type: "object", properties: { x: { type: "string" }, path: { type: "string" } } } as never,
          execute: (args) => (ran.push(`${name}:${String((args as { x?: string }).x)}`), Promise.resolve({ output: [{ type: "text", text: "ok" }] })),
        }),
      ),
    }),
  );
  const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry }, ctx);
  await store.setAgent({ id: "agent-local-a", name: "Ada" }, ctx);
  const model = { provider: faux.provider.id, modelId: faux.getModel().id };
  const chat = await store.createChat("c", { agent: opts.helpers ? { model, cwd: join(tmpdir(), "work") } : { model } }, ctx);
  await store.updateChat("c", { mode }, ctx);
  const sent: string[] = [];
  const reply = (m: ReturnType<typeof fauxAssistantMessage>) => (c: { messages: unknown[] }) => (sent.push(JSON.stringify(c.messages)), m);
  return { faux, approvals, pushed, ran, store, chat, sent, reply };
}

const until = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
};

const approvalIds = (pushed: ChatEvent[]) => pushed.flatMap((e) => (e.kind === "approval" ? [e.request_id] : []));

describe("approvals in a chat", () => {
  test("always allow: the tool stops asking (but in strict mode), in every chat, kept across a restart, until taken back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-always-"));
    const alwaysPath = join(dir, "state", "approvals.json");
    const s = await setup("standard", { alwaysPath });
    try {
      s.faux.setResponses([
        s.reply(fauxAssistantMessage(fauxToolCall("bash", { x: "1" }, { id: "t1" }), { stopReason: "toolUse" })),
        s.reply(fauxAssistantMessage(fauxToolCall("bash", { x: "2" }, { id: "t2" }), { stopReason: "toolUse" })),
        s.reply(fauxAssistantMessage("done")),
      ]);
      const run = (await s.chat.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      await until(() => approvalIds(s.pushed).length === 1);
      expect(s.approvals.decide("approval-t1", true, undefined, true)).toBe(true);
      await run;
      expect(s.ran).toEqual(["bash:1", "bash:2"]); // the second call never asked
      expect(approvalIds(s.pushed)).toEqual(["approval-t1"]);
      expect(JSON.parse(readFileSync(alwaysPath, "utf8"))).toEqual({ always: ["bash"] });
      // Strict mode asks for everything, always-allowed tools too.
      await s.store.updateChat("c", { mode: "strict" }, ctx);
      s.faux.setResponses([
        s.reply(fauxAssistantMessage(fauxToolCall("bash", { x: "3" }, { id: "t3" }), { stopReason: "toolUse" })),
        s.reply(fauxAssistantMessage("ok")),
      ]);
      const strict = (await s.chat.submit({ type: "input", content: "again" }, ctx)).wait(ctx);
      await until(() => approvalIds(s.pushed).length === 2);
      s.approvals.decide("approval-t3", true);
      await strict;
    } finally {
      await s.store.close(ctx);
    }
    // A new gate (the daemon restarted) reads what was kept; taken back, the tool asks again.
    const again = new Approvals({ alwaysPath });
    expect(again.always()).toEqual(["bash"]);
    expect(again.setAlways("bash", false)).toEqual([]);
    expect(new Approvals({ alwaysPath }).always()).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a turn another chat's message holds asks as the stricter mode, and an always-allowed tool stays allowed (plan 067)", async () => {
    const s = await setup("unrestricted");
    try {
      await s.store.updateChat("c", { turn_cap: "standard" }, ctx);
      s.faux.setResponses([
        s.reply(fauxAssistantMessage(fauxToolCall("bash", { x: "1" }, { id: "t1" }), { stopReason: "toolUse" })),
        s.reply(fauxAssistantMessage("done")),
      ]);
      const run = (await s.chat.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      await until(() => approvalIds(s.pushed).length === 1);
      expect(s.ran).toEqual([]);
      s.approvals.decide("approval-t1", true);
      await run;
      expect(s.ran).toEqual(["bash:1"]);
      // Without the hold the same chat runs it freely.
      await s.store.updateChat("c", { turn_cap: null }, ctx);
      s.faux.setResponses([
        s.reply(fauxAssistantMessage(fauxToolCall("bash", { x: "2" }, { id: "t2" }), { stopReason: "toolUse" })),
        s.reply(fauxAssistantMessage("done")),
      ]);
      await (await s.chat.submit({ type: "input", content: "again" }, ctx)).wait(ctx);
      expect(s.ran).toEqual(["bash:1", "bash:2"]);
      expect(approvalIds(s.pushed)).toEqual(["approval-t1"]);
    } finally {
      await s.store.close(ctx);
    }
  });

  test("a helper's call asks in the chat it works for", async () => {
    const s = await setup("standard", { helpers: true });
    try {
      s.faux.setResponses([
        s.reply(fauxAssistantMessage(fauxToolCall("subagent", { prompt: "count" }, { id: "p1" }), { stopReason: "toolUse" })),
        s.reply(fauxAssistantMessage(fauxToolCall("bash", { x: "h1" }, { id: "h1" }), { stopReason: "toolUse" })), // the helper
        s.reply(fauxAssistantMessage("counted")),
        s.reply(fauxAssistantMessage("done")),
      ]);
      const run = (await s.chat.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      await until(() => approvalIds(s.pushed).length === 1);
      expect(s.ran).toEqual([]);
      expect(s.approvals.waitingIn("agent-local-a", "c")).toEqual([{ kind: "approval", request_id: "approval-h1", tool_name: "bash", input: { x: "h1" } }]);
      s.approvals.decide("approval-h1", true);
      await run;
      expect(s.ran).toEqual(["bash:h1"]);
    } finally {
      await s.store.close(ctx);
    }
  });

  test("a mode made stricter while a helper runs holds for the helper's next call", async () => {
    const s = await setup("acceptEdits", { helpers: true });
    try {
      const inside = join(tmpdir(), "work", "a.ts");
      s.faux.setResponses([
        s.reply(fauxAssistantMessage(fauxToolCall("subagent", { prompt: "fix it" }, { id: "p1" }), { stopReason: "toolUse" })),
        s.reply(fauxAssistantMessage(fauxToolCall("bash", { x: "h1" }, { id: "h1" }), { stopReason: "toolUse" })),
        s.reply(fauxAssistantMessage(fauxToolCall("write", { x: "h2", path: inside }, { id: "h2" }), { stopReason: "toolUse" })),
        s.reply(fauxAssistantMessage("fixed")),
        s.reply(fauxAssistantMessage("done")),
      ]);
      const run = (await s.chat.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      await until(() => approvalIds(s.pushed).length === 1);
      // An edit inside the folder runs freely in acceptEdits; strict asks for it.
      await s.store.updateChat("c", { mode: "strict" }, ctx);
      s.approvals.decide("approval-h1", true);
      await until(() => approvalIds(s.pushed).length === 2);
      expect(s.ran).toEqual(["bash:h1"]);
      expect(approvalIds(s.pushed)).toEqual(["approval-h1", "approval-h2"]);
      s.approvals.decide("approval-h2", true);
      await run;
      expect(s.ran).toEqual(["bash:h1", "write:h2"]);
    } finally {
      await s.store.close(ctx);
    }
  });

  test("a command waits for the person; allowed, it runs; the client following the chat sees the ask and the loop", async () => {
    const s = await setup("standard");
    try {
      s.faux.setResponses([
        s.reply(fauxAssistantMessage(fauxToolCall("bash", { x: "1" }, { id: "t1" }), { stopReason: "toolUse" })),
        s.reply(fauxAssistantMessage("done")),
      ]);
      const run = (await s.chat.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      await until(() => approvalIds(s.pushed).length === 1);
      expect(s.ran).toEqual([]);
      expect(s.approvals.waitingIn("agent-local-a", "c")).toEqual([{ kind: "approval", request_id: "approval-t1", tool_name: "bash", input: { x: "1" } }]);
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
      s.faux.setResponses([
        s.reply(fauxAssistantMessage(fauxToolCall("bash", { x: "rm" }, { id: "t1" }), { stopReason: "toolUse" })),
        s.reply(fauxAssistantMessage("ok, not doing that")),
      ]);
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
        s.reply(
          fauxAssistantMessage([fauxToolCall("bash", { x: "a" }, { id: "t1" }), fauxToolCall("write", { x: "b" }, { id: "t2" })], { stopReason: "toolUse" }),
        ),
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
      const input = { questions: [{ question: "Which colour?", options: [{ label: "Red" }, { label: "Blue" }], multi_select: false }] };
      s.faux.setResponses([
        s.reply(fauxAssistantMessage(fauxToolCall("user_ask", input, { id: "q1" }), { stopReason: "toolUse" })),
        s.reply(fauxAssistantMessage("Blue it is")),
      ]);
      const run = (await s.chat.submit({ type: "input", content: "pick" }, ctx)).wait(ctx);
      await until(() => s.pushed.some((e) => e.kind === "question"));
      expect(s.pushed.find((e) => e.kind === "question")).toEqual({ kind: "question", request_id: "question-q1", input });
      expect(s.approvals.answer("question-q1", { ...input, answers: { "Which colour?": "Blue" } })).toBe(true);
      await run;
      expect(s.sent[1]).toContain('\\"Which colour?\\": Blue');
    } finally {
      await s.store.close(ctx);
    }
  });
});

/**
 * Scripts (plan 2026-11-11, U3): a store whose chats run through the gate and run scripts, with `write` (an edit) and
 * `bash` (a command) recording their runs. `mayCall` is the gate's list of what scripts may call; the daemon's is
 * daemon/scripts.ts's scriptMayCall.
 */
async function scriptSetup(mode: PermissionMode, mayCall: (name: string) => boolean = (name) => name === "write") {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const approvals = new Approvals({ kindOfTool: (name) => (name === "write" ? "edit" : "command"), scriptMayCall: mayCall });
  const pushed: ChatEvent[] = [];
  approvals.attach((_a, _c, events) => pushed.push(...events));
  const ran: string[] = [];
  const registry = createRegistry();
  const sandbox = scriptSandbox();
  registry.install(approvals.extension());
  registry.install(
    defineExtension({
      name: "tools",
      tools: ["bash", "write"].map((name) =>
        defineTool({
          name,
          description: name,
          parameters: { type: "object", properties: { x: { type: "string" } } } as never,
          execute: (args) => (ran.push(`${name}:${String((args as { x?: string }).x)}`), Promise.resolve({ output: [{ type: "text", text: "ok" }] })),
        }),
      ),
    }),
  );
  for (const e of scriptExtensions(sandbox)) registry.install(e);
  const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry }, ctx);
  await store.setAgent({ id: "agent-local-a", name: "Ada" }, ctx);
  const chat = await store.createChat("c", { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } } }, ctx);
  await store.updateChat("c", { mode }, ctx);
  const script = (code: string, id: string) => fauxAssistantMessage(fauxToolCall("codemode", { code }, { id }), { stopReason: "toolUse" });
  const close = async () => {
    await sandbox.close();
    await store.close(ctx);
  };
  const entries = () => store.entries(chat, ctx);
  return { faux, approvals, pushed, ran, chat, script, close, entries };
}

const approvalTools = (pushed: ChatEvent[]) => pushed.flatMap((e) => (e.kind === "approval" ? [e.tool_name] : []));

describe("approvals for scripts", () => {
  test("AE9: in standard mode a script asks once, as a command, and its own write runs without a second card", async () => {
    const s = await scriptSetup("standard");
    try {
      s.faux.setResponses([s.script("await tools.write({ x: 'a' }); return 'wrote'", "s1"), fauxAssistantMessage("done")]);
      const run = (await s.chat.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      await until(() => approvalIds(s.pushed).length === 1);
      expect(approvalTools(s.pushed)).toEqual(["codemode"]);
      expect(s.ran).toEqual([]);
      s.approvals.decide("approval-s1", true);
      await run;
      expect(s.ran).toEqual(["write:a"]);
      expect(approvalTools(s.pushed)).toEqual(["codemode"]);
    } finally {
      await s.close();
    }
  });

  test("AE9: in unrestricted mode the same script runs at once", async () => {
    const s = await scriptSetup("unrestricted");
    try {
      s.faux.setResponses([s.script("await tools.write({ x: 'a' }); return 'wrote'", "s1"), fauxAssistantMessage("done")]);
      await (await s.chat.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      expect(s.ran).toEqual(["write:a"]);
      expect(approvalIds(s.pushed)).toEqual([]);
    } finally {
      await s.close();
    }
  });

  test("strict mode asks for the script and again for each call it makes", async () => {
    const s = await scriptSetup("strict");
    try {
      s.faux.setResponses([s.script("await tools.write({ x: 'a' }); return 'wrote'", "s1"), fauxAssistantMessage("done")]);
      const run = (await s.chat.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      await until(() => approvalIds(s.pushed).length === 1);
      s.approvals.decide("approval-s1", true);
      await until(() => approvalIds(s.pushed).length === 2);
      expect(approvalTools(s.pushed)).toEqual(["codemode", "write"]);
      s.approvals.decide(approvalIds(s.pushed)[1] ?? "", true);
      await run;
      expect(s.ran).toEqual(["write:a"]);
    } finally {
      await s.close();
    }
  });

  test("an always-allow answer on a script's card allows that script only: the next one asks again", async () => {
    const s = await scriptSetup("standard");
    try {
      s.faux.setResponses([s.script("return 1", "s1"), s.script("return 2", "s2"), fauxAssistantMessage("done")]);
      const run = (await s.chat.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      await until(() => approvalIds(s.pushed).length === 1);
      s.approvals.decide("approval-s1", true, undefined, true);
      await until(() => approvalIds(s.pushed).length === 2);
      expect(s.approvals.always()).toEqual([]);
      s.approvals.decide("approval-s2", true);
      await run;
      expect(s.approvals.setAlways("codemode", true)).toEqual([]);
    } finally {
      await s.close();
    }
  });

  test("a script's call of a tool scripts may not call is blocked, even in unrestricted mode", async () => {
    const s = await scriptSetup("unrestricted", () => false);
    try {
      s.faux.setResponses([s.script("try { await tools.write({ x: 'a' }) } catch (e) { return e.message }", "s1"), fauxAssistantMessage("done")]);
      await (await s.chat.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      expect(s.ran).toEqual([]);
      // Blocked by the gate, with its reason, not failed some other way.
      const results = (await s.entries()).filter((e) => e.kind === "pi.tool-result").map((e) => JSON.stringify(e.model));
      expect(results.join("\n")).toContain("A script may not call write.");
    } finally {
      await s.close();
    }
  });

  test("a script's card offers no always-allow; a command's does", () => {
    expect(offersAlways({ toolName: "codemode" })).toBe(false);
    expect(offersAlways({ toolName: "write" })).toBe(true);
  });
});
