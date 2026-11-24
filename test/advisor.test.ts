import { describe, expect, test, vi } from "vitest";
import { mkdirSync, symlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { ADVISOR_PROMPT, type AdvisorOpen } from "../daemon/advisor.ts";
import { ADVISOR_TOOLS } from "../daemon/advisor-gate.ts";
import { PassRunner, type PassInput } from "../daemon/passes.ts";
import { PassState } from "../daemon/passes-state.ts";
import { REPLIES_PROMPT } from "../daemon/replies.ts";
import { withKind } from "../daemon/tool-kinds.ts";
import { AGENT, advisorSetup } from "./fixtures/advisor.ts";
import { must } from "./fixtures/must.ts";

const ctx = BACKGROUND_CONTEXT;

const FORBIDDEN = [
  "write",
  "edit",
  "memory_write",
  "memory_edit",
  "memory_delete",
  "subagent",
  "chat_message",
  "suggestion_create",
  "user_ask",
  "codemode",
  "schedule_create",
  "background_run",
];

const sent = (text: string) => JSON.stringify(text).slice(1, -1);

const opened = (result: AdvisorOpen) => {
  if ("refused" in result) throw new Error(`refused: ${result.refused}`);
  return result;
};

const modTools = defineExtension({
  name: "a-mod",
  tools: ["chat_message", "suggestion_create", "codemode"].map((name) =>
    withKind(
      "read",
      defineTool({ name, description: name, parameters: { type: "object", properties: {} } as never, execute: () => Promise.resolve({ output: [] }) }),
    ),
  ),
  sections: [section("canvas", () => "The canvas beside this chat shows widgets."), section("accounts", () => "Your accounts: read them with a script.")],
});

describe("a chat's advisor", () => {
  test("two opens at once for one chat make one advisor chat", async () => {
    const s = await advisorSetup();
    try {
      await s.store.createChat("c", { agent: { model: s.model, cwd: s.folder } }, ctx);
      const [a, b] = await Promise.all([s.advisors.open(AGENT, "c"), s.advisors.open(AGENT, "c")]);
      expect(opened(a).advisorId).toBe("advisor-c");
      expect(opened(b).advisorId).toBe("advisor-c");
      expect([opened(a).created, opened(b).created].sort()).toEqual([false, true]);
      expect((await s.store.chats(ctx)).filter((info) => info.advisor_for === "c").map((info) => info.id)).toEqual(["advisor-c"]);
    } finally {
      await s.cleanup();
    }
  });

  test("it is hidden, in standard mode, marked with its chat, in the chat's folder, and offered the advisor's tools by name and nothing else", async () => {
    const s = await advisorSetup();
    try {
      s.registry.install(modTools);
      await s.store.createChat("c", { agent: { model: s.model, cwd: s.folder } }, ctx);
      const { chat } = opened(await s.advisors.open(AGENT, "c"));
      const info = must(await s.store.chatInfo(chat.id, ctx), "the advisor's info");
      expect(info).toMatchObject({ id: "advisor-c", hidden: true, mode: "standard", advisor_for: "c" });
      const agent = await chat.agent(ctx);
      expect(agent.cwd).toBe(s.folder);
      expect(agent.tools.map((t) => t.name).sort()).toEqual([...ADVISOR_TOOLS].sort());
      for (const name of FORBIDDEN) expect(agent.tools.map((t) => t.name)).not.toContain(name);

      const normal = await must(await s.store.chat("c", ctx), "the chat").agent(ctx);
      expect(normal.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["write", "memory_write", "chat_message"]));
      expect(normal.tools.map((t) => t.name)).not.toContain("ls");
    } finally {
      await s.cleanup();
    }
  });

  test("with no advisor model, an agent on one of loki's models gets an advisor on that model (AE5)", async () => {
    const s = await advisorSetup();
    try {
      await s.store.createChat("c", { agent: { cwd: s.folder } }, ctx);
      const agent = await opened(await s.advisors.open(AGENT, "c")).chat.agent(ctx);
      expect(agent.model).toEqual(s.model);
      expect(agent.thinkingLevel).toBe("off");
    } finally {
      await s.cleanup();
    }
  });

  test("with no advisor model, the advisor takes the agent's own effort with its model", async () => {
    const s = await advisorSetup(() => ({ model_settings: { reasoning_effort: "high" } }));
    try {
      await s.store.createChat("c", { agent: { cwd: s.folder } }, ctx);
      const agent = await opened(await s.advisors.open(AGENT, "c")).chat.agent(ctx);
      expect(agent.model).toEqual(s.model);
      expect(agent.thinkingLevel).toBe("high");
    } finally {
      await s.cleanup();
    }
  });

  test("an agent on Claude Code with no advisor model is refused with a note to set one in Agents › Profile, and no advisor is made (AE6)", async () => {
    const s = await advisorSetup(() => ({ model: "acp:claude/sonnet" }));
    try {
      await s.store.createChat("c", {}, ctx);
      const result = await s.advisors.open(AGENT, "c");
      expect(result).toEqual({ refused: expect.stringContaining("Agents › Profile") as unknown });
      expect(await s.store.chat("advisor-c", ctx)).toBeUndefined();
    } finally {
      await s.cleanup();
    }
  });

  test("an advisor model set in Profile wins over the agent's own, with its effort; one this Mac cannot reach is refused", async () => {
    const t = await advisorSetup((handle) => ({ model: "acp:claude/sonnet", advisor_model: handle, advisor_reasoning_effort: "high" }));
    try {
      await t.store.createChat("c", {}, ctx);
      const agent = await opened(await t.advisors.open(AGENT, "c")).chat.agent(ctx);
      expect(agent.model).toEqual(t.model);
      expect(agent.thinkingLevel).toBe("high");
      t.reachable.clear();
      await t.store.createChat("d", {}, ctx);
      expect(await t.advisors.open(AGENT, "d")).toEqual({ refused: expect.stringContaining("Agents › Profile") as unknown });
    } finally {
      await t.cleanup();
    }
  });

  test("its prompt has the advisor's section and memory it may only read, and none of the replies, canvas, accounts or script lines", async () => {
    const s = await advisorSetup();
    try {
      s.registry.install(modTools);
      await s.store.createChat("c", { agent: { model: s.model, cwd: s.folder } }, ctx);
      const prompts: string[] = [];
      const answer = (c: unknown) => (prompts.push(JSON.stringify(c)), fauxAssistantMessage("Nothing new."));
      s.faux.setResponses([answer, answer]);
      const { chat } = opened(await s.advisors.open(AGENT, "c"));
      await (await chat.submit({ type: "input", content: "look at a.ts" }, ctx)).wait(ctx);
      await (await must(await s.store.chat("c", ctx), "the chat").submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
      const [advisor, normal] = prompts;

      expect(advisor).toContain(sent(ADVISOR_PROMPT));
      for (const line of ["Not asked, but noticed", "Could not check", "\nNothing new."]) expect(advisor).toContain(sent(line));
      expect(advisor).toContain(sent("I am Ada."));
      expect(advisor).toContain(sent("read it with memory_read but never change it"));
      expect(advisor).toContain(sent("- review: review code"));
      for (const text of [REPLIES_PROMPT, "The canvas beside", "Your accounts", "change with the memory tools", "in a script"])
        expect(advisor).not.toContain(sent(text));

      expect(normal).toContain(sent(REPLIES_PROMPT));
      expect(normal).toContain(sent("The canvas beside"));
      expect(normal).not.toContain(sent(ADVISOR_PROMPT));
    } finally {
      await s.cleanup();
    }
  });

  test("after a compaction, the advisor's note on its history names the tools it calls itself, not a script", async () => {
    const s = await advisorSetup();
    try {
      vi.spyOn(s.chats, "compactedSince").mockReturnValue(true);
      await s.store.createChat("c", { agent: { model: s.model, cwd: s.folder } }, ctx);
      let prompt = "";
      s.faux.setResponses([(c: unknown) => ((prompt = JSON.stringify(c)), fauxAssistantMessage("Nothing new."))]);
      const { chat } = opened(await s.advisors.open(AGENT, "c"));
      await (await chat.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      expect(prompt).toContain(sent("Find them with history_search and read them with history_read before you guess."));
    } finally {
      await s.cleanup();
    }
  });

  test("ls, find, grep, history_search and history_read are called by the advisor's model directly", async () => {
    const s = await advisorSetup();
    try {
      await s.store.createChat("c", { agent: { model: s.model, cwd: s.folder } }, ctx);
      const { chat } = opened(await s.advisors.open(AGENT, "c"));
      const [ls, find, grep, search, read] = await s.turn(chat, [
        ["ls", {}],
        ["find", { pattern: "**/*.ts" }],
        ["grep", { pattern: "answer" }],
        ["history_search", { query: "go" }],
        ["history_read", { from: 0 }],
      ]);
      expect(ls).toMatchObject({ name: "ls", failed: false, text: "a.ts" });
      expect(find).toMatchObject({ name: "find", failed: false, text: "a.ts" });
      expect(grep.text).toContain("answer = 42");
      expect(search).toMatchObject({ name: "history_search", failed: false });
      expect(read).toMatchObject({ name: "history_read", failed: false });
      expect(s.pushed.filter((e) => e.kind === "approval")).toEqual([]);
    } finally {
      await s.cleanup();
    }
  });

  test("a link in the chat's folder into loki's data folder is neither listed by find nor read by grep, with rg or without it", async () => {
    const s = await advisorSetup();
    try {
      const stores = join(s.dataDir, "stores");
      symlinkSync(relative(s.folder, stores), join(s.folder, "kept"), "junction");
      if (process.platform !== "win32") symlinkSync(relative(s.folder, join(stores, `${AGENT}.sqlite`)), join(s.folder, "thread.ts"));
      await s.store.createChat("c", { agent: { model: s.model, cwd: s.folder } }, ctx);
      const { chat } = opened(await s.advisors.open(AGENT, "c"));
      const calls: Array<[string, Record<string, string>]> = [
        ["find", { pattern: "**/*" }],
        ["grep", { pattern: "whole thread" }],
      ];
      const [find, grep] = await s.turn(chat, calls);
      const noRg = join(s.root, "no-programs");
      mkdirSync(noRg);
      vi.stubEnv("PATH", noRg);
      const [walkedGrep] = await s.turn(chat, [["grep", { pattern: "whole thread" }]]);
      vi.unstubAllEnvs();
      expect(find).toMatchObject({ failed: false, text: "a.ts" });
      for (const result of [grep, walkedGrep]) expect(result).toMatchObject({ failed: false, text: "no matches" });
      expect(s.pushed.filter((e) => e.kind === "approval")).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      await s.cleanup();
    }
  });

  test("Reflection's sweep over the agent's chats leaves the advisor chat out", async () => {
    const s = await advisorSetup();
    try {
      const long = "a thought worth keeping about how the river delta builds land over centuries, ".repeat(5);
      const seen: PassInput[] = [];
      const state = new PassState(join(s.root, "state"));
      state.setSettings({ reflection: { enabled: true }, learn: { enabled: false } });
      const runner = new PassRunner({
        stores: s.stores,
        chats: s.chats,
        registry: s.registry,
        state,
        backendDir: s.backend,
        context: ctx,
        jobs: [
          {
            name: "reflection",
            chatId: (a) => `reflection-${a}`,
            title: "reflection",
            instructions: "test",
            tools: () => [],
            prompt: (input) => (seen.push(input), "read this"),
            apply: () => ({ items: {} }),
          },
        ],
        busy: () => Promise.resolve(false),
        quietMs: 0,
      });
      const c = await s.store.createChat("c", { agent: { model: s.model, cwd: s.folder } }, ctx);
      const { chat } = opened(await s.advisors.open(AGENT, "c"));
      const at = Date.now() - 10;
      for (const conversation of [c, chat])
        await s.store.appendEntries(
          conversation,
          [
            { kind: "pi.user", message: { role: "user", content: [{ type: "text", text: long }], timestamp: at } },
            { kind: "pi.assistant", message: { role: "assistant", content: [{ type: "text", text: long }], timestamp: at + 1 } },
          ],
          null,
          ctx,
        );
      s.faux.setResponses([fauxAssistantMessage("kept")]);
      await runner.sweep();
      expect(seen.flatMap((input) => input.parts.map((p) => p.chatId))).toEqual(["c"]);
    } finally {
      await s.cleanup();
    }
  });
});
