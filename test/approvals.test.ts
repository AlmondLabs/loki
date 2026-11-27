import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, MemoryStorage } from "@earendil-works/pi-durable";
import { Approvals, asks } from "../daemon/approvals.ts";
import { BackgroundTasks } from "../daemon/background.ts";
import type { PermissionMode } from "../core/chat-links.ts";
import { askExtension } from "../daemon/ask.ts";
import { builtinExtensions } from "../daemon/extensions.ts";
import { AgentStore, ChatDoc } from "../daemon/kernel/index.ts";
import { readOnlyRefusal, READ_ONLY_EXTENSION, READ_ONLY_TOOLS } from "../daemon/read-only-gate.ts";
import { Schedules } from "../daemon/schedule.ts";
import { subagentExtension } from "../daemon/subagents.ts";
import { offersAlways, type ChatEvent } from "../core/attention/model.ts";
import { scriptExtensions, scriptSandbox } from "../daemon/scripts.ts";
import { chatEnvs, resultsDirOf } from "../daemon/tool-results.ts";

const AGENT = "agent-local-ada";

const ctx = BACKGROUND_CONTEXT;

describe("the permission modes", () => {
  const table = (mode: PermissionMode) => ({
    plan: asks(mode, "plan", { steps: [{ title: "Step one", status: "in_progress" }] }, { kind: "read" }),
    read: asks(mode, "read", { path: "/work/a" }, { cwd: "/work" }),
    editInside: asks(mode, "edit", { path: "a.ts" }, { cwd: "/work" }),
    command: asks(mode, "bash", { command: "rm a.ts" }, { cwd: "/work" }),
    readCommand: asks(mode, "bash", { command: "rg -n answer src | head" }, { cwd: "/work" }),
    readBackground: asks(mode, "bash", { command: "rg -n answer src", background: true }, { cwd: "/work", kind: "command" }),
    readWait: asks(mode, "bash", { command: "rg -n answer src", wait_ms: 500 }, { cwd: "/work", kind: "command" }),
    watch: asks(mode, "background_watch", { task_id: "bg-1", pattern: "ready" }, { kind: "read" }),
    watchStop: asks(mode, "background_watch", { task_id: "bg-1", stop: true }, { kind: "read" }),
    watchInput: asks(mode, "background_watch", { task_id: "bg-1", input: "y\n" }, { kind: "read" }),
    subagentInherit: asks(mode, "subagent", { prompt: "inspect" }, { kind: "read" }),
    subagentWorktree: asks(mode, "subagent", { prompt: "edit", workspace: "worktree" }, { kind: "read" }),
    subagentStop: asks(mode, "subagent_stop", { subagent_id: "sub-1" }, { kind: "command" }),
    widget: asks(mode, "write", { path: "/home/x/.loki/widgets/c/w.json" }, { cwd: "/work", widgetsDir: "/home/x/.loki/widgets" }),
  });

  test("each mode asks as the app describes it, a read-only shell command is a read, and loki's widget folder never asks", () => {
    expect(table("strict")).toEqual({
      plan: false,
      read: true,
      editInside: true,
      command: true,
      readCommand: true,
      readBackground: true,
      readWait: true,
      watch: true,
      watchStop: true,
      watchInput: true,
      subagentInherit: true,
      subagentWorktree: true,
      subagentStop: true,
      widget: false,
    });
    expect(table("standard")).toEqual({
      plan: false,
      read: false,
      editInside: true,
      command: true,
      readCommand: false,
      readBackground: true,
      readWait: true,
      watch: false,
      watchStop: true,
      watchInput: true,
      subagentInherit: false,
      subagentWorktree: true,
      subagentStop: true,
      widget: false,
    });
    expect(table("acceptEdits")).toEqual({
      plan: false,
      read: false,
      editInside: false,
      command: true,
      readCommand: false,
      readBackground: true,
      readWait: true,
      watch: false,
      watchStop: true,
      watchInput: true,
      subagentInherit: false,
      subagentWorktree: true,
      subagentStop: true,
      widget: false,
    });
    expect(table("unrestricted")).toEqual({
      plan: false,
      read: false,
      editInside: false,
      command: false,
      readCommand: false,
      readBackground: false,
      readWait: false,
      watch: false,
      watchStop: false,
      watchInput: false,
      subagentInherit: false,
      subagentWorktree: false,
      subagentStop: false,
      widget: false,
    });
  });

  test("a question card is never a permission, and a path that climbs out of the widget folder is not inside it", () => {
    expect(asks("strict", "user_ask", {}, {})).toBe(false);
    for (const name of ["chat_list", "suggestion_create", "message_propose", "ticket_propose"]) expect(asks("strict", name, {}, {})).toBe(false);
    expect(asks("strict", "chat_message", {}, {})).toBe(false);
    expect(asks("standard", "write", { path: "/home/x/.loki/widgets/../secrets" }, { widgetsDir: "/home/x/.loki/widgets" })).toBe(true);
  });
});

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
      expect(s.ran).toEqual(["bash:1", "bash:2"]);
      expect(approvalIds(s.pushed)).toEqual(["approval-t1"]);
      expect(JSON.parse(readFileSync(alwaysPath, "utf8"))).toEqual({ always: ["bash"] });
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
        s.reply(fauxAssistantMessage(fauxToolCall("bash", { x: "h1" }, { id: "h1" }), { stopReason: "toolUse" })),
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
      expect(s.approvals.decide("approval-t1", true)).toBe(false);
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

async function scriptSetup(mode: PermissionMode, mayCall: (name: string) => boolean = (name) => name === "write") {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const approvals = new Approvals({ kindOfTool: (name) => (name === "write" ? "edit" : name === "codemode" ? "read" : "command"), scriptMayCall: mayCall });
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
  test("in standard mode a script that only reads runs without a card (plan 097, KTD3)", async () => {
    const s = await scriptSetup("standard");
    try {
      s.faux.setResponses([s.script("return 1 + 1", "s1"), fauxAssistantMessage("done")]);
      await (await s.chat.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      expect(approvalIds(s.pushed)).toEqual([]);
    } finally {
      await s.close();
    }
  });

  test("in standard mode a script asks once, at its first change, showing the script and that call; the rest of the run follows the answer", async () => {
    const s = await scriptSetup("standard");
    try {
      const code = "await tools.write({ x: 'a' }); await Promise.all([tools.write({ x: 'b' }), tools.write({ x: 'c' })]); return 'wrote'";
      s.faux.setResponses([s.script(code, "s1"), fauxAssistantMessage("done")]);
      const run = (await s.chat.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      await until(() => approvalIds(s.pushed).length === 1);
      expect(s.ran).toEqual([]);
      expect(s.pushed.find((e) => e.kind === "approval")).toEqual({
        kind: "approval",
        request_id: "approval-script-s1",
        tool_name: "codemode",
        input: { code, first_call: { tool: "write", input: { x: "a" } } },
      });
      s.approvals.decide("approval-script-s1", true);
      await run;
      expect([...s.ran].sort()).toEqual(["write:a", "write:b", "write:c"]);
      expect(approvalIds(s.pushed)).toEqual(["approval-script-s1"]);
    } finally {
      await s.close();
    }
  });

  test("a declined script's call and every later one in the run is refused, calls made at once included", async () => {
    const s = await scriptSetup("standard");
    try {
      const code =
        "const out = []; for (const x of ['a', 'b']) { try { await tools.write({ x }) } catch (e) { out.push(e.message) } }" +
        " await Promise.allSettled([tools.write({ x: 'c' }), tools.write({ x: 'd' })]).then((r) => r.forEach((x) => out.push(x.status))); return out.join(' | ')";
      s.faux.setResponses([s.script(code, "s1"), fauxAssistantMessage("done")]);
      const run = (await s.chat.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      await until(() => approvalIds(s.pushed).length === 1);
      s.approvals.decide("approval-script-s1", false, "not now");
      await run;
      expect(s.ran).toEqual([]);
      expect(approvalIds(s.pushed)).toEqual(["approval-script-s1"]);
      const result = JSON.stringify((await s.entries()).filter((e) => e.kind === "pi.tool-result").map((e) => e.model));
      expect(result).toContain("not now");
      expect(result).toContain("rejected | rejected");
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
    const s = await scriptSetup("strict");
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
      const results = (await s.entries()).filter((e) => e.kind === "pi.tool-result").map((e) => JSON.stringify(e.model));
      expect(results.join("\n")).toContain("A script may not call write.");
    } finally {
      await s.close();
    }
  });

  test("a script's card offers no always-allow; a command's does unless allowAlways is false", () => {
    expect(offersAlways({ toolName: "codemode" })).toBe(false);
    expect(offersAlways({ toolName: "write" })).toBe(true);
    expect(offersAlways({ toolName: "write", allowAlways: false })).toBe(false);
    expect(offersAlways({ toolName: "write", allowAlways: true })).toBe(true);
  });
});

async function readOnlySetup() {
  const root = mkdtempSync(join(tmpdir(), "loki-read-only-"));
  const dataDir = join(root, "home", ".loki");
  const backend = join(dataDir, "backend");
  const home = join(root, "home");
  const folder = join(root, "work");
  const skillDir = join(backend, "memfs", AGENT, "memory", "skills", "review");
  mkdirSync(folder, { recursive: true });
  mkdirSync(skillDir, { recursive: true });
  mkdirSync(join(dataDir, "stores"), { recursive: true });
  writeFileSync(join(dataDir, "stores", `${AGENT}.sqlite`), "sqlite-data");
  writeFileSync(join(folder, "a.ts"), "export const answer = 42;\n");
  writeFileSync(join(skillDir, "SKILL.md"), "Read the diff first.\n");

  const pushed: ChatEvent[] = [];
  const approvals = new Approvals({
    readOnlyFolders: { dataDir, backendDir: backend, home },
  });
  approvals.attach((_agentId, _convId, events) => pushed.push(...events));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  for (const ext of builtinExtensions({
    approvals,
    backendDir: backend,
    background: new BackgroundTasks(() => {}),
    schedules: new Schedules(join(root, "crons.json"), () => Promise.resolve(null)),
    history: { thread: () => [], compactedSince: () => false },
  })) {
    registry.install(ext);
  }
  const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry, env: chatEnvs(dataDir) }, ctx);
  await store.setAgent({ id: AGENT, name: "Ada" }, ctx);
  const model = { provider: faux.provider.id, modelId: faux.getModel().id };

  const turn = async (chat: Awaited<ReturnType<AgentStore["createChat"]>>, calls: Array<[string, Parameters<typeof fauxToolCall>[1]]>) => {
    const start = (await store.entries(chat, ctx)).length;
    faux.setResponses([
      ...calls.map(([name, args], i) => fauxAssistantMessage(fauxToolCall(name, args, { id: `call-${i}` }), { stopReason: "toolUse" })),
      fauxAssistantMessage("Done."),
    ]);
    await (await chat.submit({ type: "input", content: "inspect" }, ctx)).wait(ctx);
    return (await store.entries(chat, ctx))
      .slice(start)
      .filter((e) => e.kind === "pi.tool-result")
      .map((e) => ({ failed: e.model?.some((m) => m.role === "toolResult" && m.isError) ?? false, text: JSON.stringify(e.model) }));
  };

  return {
    root,
    dataDir,
    backend,
    home,
    folder,
    pushed,
    approvals,
    registry,
    store,
    model,
    turn,
    cleanup: async () => {
      await store.close(ctx);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("a read-only subagent chat's gate", () => {
  type Setup = Awaited<ReturnType<typeof readOnlySetup>>;
  const workerOf = async (s: Setup, chatId: string, cwd?: string) => {
    const snap = s.registry.snapshot();
    const readOnlyExt = snap.extension(READ_ONLY_EXTENSION);
    if (!readOnlyExt) throw new Error("missing read-only extension");
    const byName = new Map(snap.tools().map(({ tool }) => [tool.name, tool]));
    const readOnlyTools = READ_ONLY_TOOLS.flatMap((n) => byName.get(n) ?? []);
    const chat = await s.store.createChat(
      chatId,
      {
        hidden: true,
        agent: {
          model: s.model,
          cwd: cwd ?? s.home,
          extensions: { add: [readOnlyExt] },
          tools: readOnlyTools,
        },
      },
      ctx,
    );
    await chat.commit(async (tx) => {
      const info = await tx.doc(ChatDoc, chat.id);
      info.read_only = true;
      info.subagent_for = "c";
    }, ctx);
    await chat.configure({ modelTools: readOnlyTools }, ctx);
    return chat;
  };
  const cards = (s: Setup) => s.pushed.filter((e) => e.kind === "approval");

  test("a call to write is refused with a reason, changes nothing and shows no card, even once the worker's tool list is lost", async () => {
    const s = await readOnlySetup();
    try {
      const chat = await workerOf(s, "c~subagent~kestrel", s.folder);
      const [offList] = await s.turn(chat, [["write", { path: "a.ts", content: "gone" }]]);
      expect(offList).toMatchObject({ failed: true, text: expect.stringContaining("Tool write is not available") as unknown });
      await chat.configure({ tools: null, modelTools: null }, ctx);
      expect((await chat.agent(ctx)).tools.map((t) => t.name)).toContain("write");
      const [write] = await s.turn(chat, [["write", { path: "a.ts", content: "gone" }]]);
      expect(write).toMatchObject({
        failed: true,
        text: expect.stringContaining("A read-only subagent reads and never changes anything, so it cannot use write.") as unknown,
      });
      expect(readFileSync(join(s.folder, "a.ts"), "utf8")).toBe("export const answer = 42;\n");
      expect(cards(s)).toEqual([]);
    } finally {
      await s.cleanup();
    }
  });

  test("bash may run cat, and is refused rm and git status, with no card", async () => {
    const s = await readOnlySetup();
    try {
      const chat = await workerOf(s, "c~subagent~kestrel", s.folder);
      const [rm, git] = await s.turn(chat, [
        ["bash", { command: "rm a.ts" }],
        ["bash", { command: "git status" }],
      ]);
      for (const result of [rm, git]) expect(result).toMatchObject({ failed: true, text: expect.stringContaining("only commands that read") as unknown });
      expect(existsSync(join(s.folder, "a.ts"))).toBe(true);
      expect(cards(s)).toEqual([]);
      const folders = { dataDir: s.dataDir, backendDir: s.backend, home: s.home };
      expect(
        await readOnlyRefusal({ name: "bash", args: { command: "cat a.ts" }, cwd: s.folder, agentId: AGENT, chatId: "c~subagent~kestrel" }, folders),
      ).toBeNull();
    } finally {
      await s.cleanup();
    }
  });

  test.runIf(process.platform !== "win32")("bash's cat a.ts runs in the chat's folder", async () => {
    const s = await readOnlySetup();
    try {
      const [cat] = await s.turn(await workerOf(s, "c~subagent~kestrel", s.folder), [["bash", { command: "cat a.ts" }]]);
      expect(cat.text).toContain("export const answer = 42;");
      expect(cards(s)).toEqual([]);
    } finally {
      await s.cleanup();
    }
  });

  test("read refuses a chat store in loki's data folder and reads a file in the chat's folder", async () => {
    const s = await readOnlySetup();
    try {
      const [store, file] = await s.turn(await workerOf(s, "c~subagent~kestrel", s.folder), [
        ["read", { path: join(s.dataDir, "stores", `${AGENT}.sqlite`) }],
        ["read", { path: "a.ts" }],
      ]);
      expect(store).toMatchObject({ failed: true, text: expect.stringContaining("inside loki's data folder") as unknown });
      expect(file).toMatchObject({ failed: false, text: expect.stringContaining("export const answer = 42;") as unknown });
      expect(cards(s)).toEqual([]);
    } finally {
      await s.cleanup();
    }
  });

  test("the home folder's way in, a search above the data folder and a link into it are each refused with a reason and no card", async () => {
    const s = await readOnlySetup();
    try {
      symlinkSync(join(s.dataDir, "stores"), join(s.folder, "stores"), "junction");
      const inFolder = await s.turn(await workerOf(s, "c~subagent~kestrel", s.folder), [["read", { path: join("stores", `${AGENT}.sqlite`) }]]);
      const noFolder = await workerOf(s, "c~subagent~ember");
      expect((await noFolder.agent(ctx)).cwd).toBe(s.home);
      const fromHome = await s.turn(noFolder, [
        ["bash", { command: `cat ~/.loki/stores/${AGENT}.sqlite` }],
        ["bash", { command: "grep -r x ~" }],
        ["grep", { pattern: "x" }],
        ["bash", { command: "find ~" }],
        ["find", { pattern: "*", path: "~" }],
      ]);
      for (const result of [...inFolder, ...fromHome]) {
        expect(result.failed).toBe(true);
        expect(result.text).toContain("loki's data folder");
      }
      expect(cards(s)).toEqual([]);
    } finally {
      await s.cleanup();
    }
  });

  test("the agent's own skill and the worker's own saved output read; another chat's saved output is refused", async () => {
    const s = await readOnlySetup();
    try {
      const own = resultsDirOf(s.dataDir, "c~subagent~kestrel");
      const other = resultsDirOf(s.dataDir, "c");
      for (const [dir, text] of [
        [own, "the worker's long output"],
        [other, "the chat's long output"],
      ]) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "bash-1.log"), text);
      }
      const [skill, mine, theirs] = await s.turn(await workerOf(s, "c~subagent~kestrel", s.folder), [
        ["read", { path: join(s.backend, "memfs", AGENT, "memory", "skills", "review", "SKILL.md") }],
        ["read", { path: join(own, "bash-1.log") }],
        ["read", { path: join(other, "bash-1.log") }],
      ]);
      expect(skill).toMatchObject({ failed: false, text: expect.stringContaining("Read the diff first.") as unknown });
      expect(mine).toMatchObject({ failed: false, text: expect.stringContaining("the worker's long output") as unknown });
      expect(theirs).toMatchObject({ failed: true, text: expect.stringContaining("loki's data folder") as unknown });
      expect(cards(s)).toEqual([]);
    } finally {
      await s.cleanup();
    }
  });

  test("globs, searches that follow links, another person's home and paths inside options are judged as the shell would reach them", async () => {
    const s = await readOnlySetup();
    try {
      const folders = { dataDir: s.dataDir, backendDir: s.backend, home: s.home };
      const judge = (name: string, args: Record<string, unknown>) =>
        readOnlyRefusal({ name, args, cwd: s.folder, agentId: AGENT, chatId: "c~subagent~kestrel" }, folders);
      const bash = (command: string) => judge("bash", { command });
      for (const command of ["cat ~/.lo*/stores/x", "cat [t]hread.ts", "cat *.ts | wc -l", "grep x *", "head -n 5 ./*"])
        expect(await bash(command), command).toContain("may not use a wildcard");
      expect(await bash("grep -f~/.loki/stores/x y a.ts")).toContain("loki's data folder");
      expect(await bash("rg --ignore-file=~/.loki/stores/x y")).toContain("loki's data folder");
      expect(await bash("grep -R x .")).toContain("may not follow links");
      expect(await bash("rg -L x .")).toContain("may not follow links");
      for (const command of ["grep -rS x .", "grep -rO x .", "grep -r -S x .", "grep -Sr x ."])
        expect(await bash(command), command).toContain("may not follow links");
      for (const command of ["grep --recur x .", "grep --dir=recurse x .", "grep --deref x .", "grep --directories recurse x .", "ls --recur ."])
        expect(await bash(command), command).toContain("is not a long option");
      expect(await bash("cat ~someone/notes")).toContain("another home folder");
      expect(await judge("changes_read", { kind: "diff", paths: [s.dataDir] })).toContain("loki's data folder");
      for (const [name, args] of [
        ["bash", { command: "cat a.ts | wc -l" }],
        ["bash", { command: "grep -rn answer ." }],
        ["bash", { command: "grep -rn --ignore-case --include='*.ts' --context=2 answer ." }],
        ["bash", { command: "find . -name '*.ts'" }],
        ["changes_read", { kind: "status" }],
        ["memory_read", { path: "system/persona.md" }],
        ["web_search", { query: "loki" }],
      ] as const)
        expect(await judge(name, args), name).toBeNull();
      expect(await readOnlyRefusal({ name: "read", args: { path: "a.ts" }, cwd: s.folder, agentId: AGENT, chatId: "c~subagent~kestrel" }, undefined)).toContain(
        "cannot check",
      );
    } finally {
      await s.cleanup();
    }
  });
});
