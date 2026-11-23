import { describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { join } from "node:path";
import { consultOf } from "../core/advisor.ts";
import { contentText } from "../core/harness.ts";
import { consultTextOf } from "../daemon/advisor-changes.ts";
import type { ConsultReply } from "../daemon/advisor-consults.ts";
import { asks } from "../daemon/approvals.ts";
import { AgentStore } from "../daemon/kernel/index.ts";
import { ModRegistry } from "../daemon/mods/registry.ts";
import type { ModApi, ModTool } from "../daemon/mods/api.ts";
import type { DeskSummary } from "../core/frame-types.ts";
import type { AdvisorConsulting } from "../mod/advisor.ts";
import { DeskStore } from "../mod/desk-store.ts";
import { GestureLog } from "../mod/gestures.ts";
import { isPassChat } from "../mod/recall-worker.ts";
import { registerTools } from "../mod/tools.ts";
import { AGENT, consultSetup, until } from "./fixtures/advisor-consult.ts";
import { must } from "./fixtures/must.ts";

const ctx = BACKGROUND_CONTEXT;

const tool = (name: string, forAgent?: (agentId: string) => boolean): ModTool => ({
  name,
  description: `The ${name} tool`,
  parameters: { type: "object", properties: {} },
  execute: () => name,
  ...(forAgent ? { forAgent } : {}),
});

async function setup(allowed: Set<string>) {
  const mods = new ModRegistry(() => {});
  await mods.load({
    name: "accounts",
    apiVersion: 1,
    activate: (api) => {
      api.tools.register(tool("everyone"));
      api.tools.register(tool("account_read", (agentId) => allowed.has(agentId)));
    },
  });
  const models = createModels();
  const open = async (id: string, name: string) => {
    const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry: mods.registry }, ctx);
    await store.setAgent({ id, name }, ctx);
    const chat = await store.createChat(`local-conv-${name.toLowerCase()}`, { title: null }, ctx);
    return { store, chat };
  };
  const a = await open("agent-local-ada", "Ada");
  const b = await open("agent-local-bo", "Bo");
  const offered = async (c: typeof a) => {
    await mods.prepare(c.store, c.chat, ctx);
    return (await c.chat.agent(ctx)).tools.map((t) => t.name).filter((n) => n === "everyone" || n === "account_read");
  };
  const close = async () => {
    await a.store.close(ctx);
    await b.store.close(ctx);
  };
  return { a, b, offered, close };
}

describe("per-agent mod tools on loki's engine (plan 067, U1)", () => {
  test("a tool without forAgent is offered to every agent's chat; one for agent A only is offered in A's chats and not B's", async () => {
    const s = await setup(new Set(["agent-local-ada"]));
    try {
      expect(await s.offered(s.a)).toEqual(["everyone", "account_read"]);
      expect(await s.offered(s.b)).toEqual(["everyone"]);
    } finally {
      await s.close();
    }
  });

  test("what forAgent answers decides the next turn's list", async () => {
    const allowed = new Set(["agent-local-ada"]);
    const s = await setup(allowed);
    try {
      expect(await s.offered(s.b)).toEqual(["everyone"]);
      allowed.add("agent-local-bo");
      allowed.delete("agent-local-ada");
      expect(await s.offered(s.b)).toEqual(["everyone", "account_read"]);
      expect(await s.offered(s.a)).toEqual(["everyone"]);
    } finally {
      await s.close();
    }
  });

  test("tools hidden from the chat by someone else (MCP's filter) stay hidden", async () => {
    const s = await setup(new Set());
    try {
      await s.b.chat.configure({ tools: { remove: [{ name: "mcp__fake__list_issues" } as never] } }, ctx);
      await s.offered(s.b);
      expect(await s.b.store.agentSettings(s.b.chat.id, ctx)).toMatchObject({ tools: { remove: ["mcp__fake__list_issues", "account_read"] } });
    } finally {
      await s.close();
    }
  });
});

function lokiMod(advisor: AdvisorConsulting, chats: () => DeskSummary[] = () => []) {
  return (api: ModApi) =>
    registerTools(api, {
      store: new DeskStore(),
      gestures: new GestureLog(),
      widgets: { entries: () => [], get: () => undefined, setRuntimeError: () => false, rescan: () => Promise.resolve(), close: () => {} },
      widgetsDir: join("/", "widgets"),
      activeScope: () => "shared",
      broadcast: () => {},
      chats: { suggestions: { add: () => Promise.reject(new Error("no suggestions here")) }, agents: () => [], chats, passChat: isPassChat, advisor },
    });
}

function consultTool(advisor: AdvisorConsulting, chats?: () => DeskSummary[]) {
  const tools: ModTool[] = [];
  const api = {
    tools: { register: (t: ModTool) => (tools.push(t), () => {}) },
    prompt: { section: () => () => {} },
  } as unknown as ModApi;
  lokiMod(advisor, chats)(api);
  const tool = must(
    tools.find((t) => t.name === "advisor_consult"),
    "advisor_consult",
  );
  return (args: Record<string, unknown>, chatId = "local-conv-work", cwd?: string) =>
    Promise.resolve(
      tool.execute(args, {
        chatId,
        agentId: "agent-local-ada",
        agentName: "Ada",
        signal: new AbortController().signal,
        output: () => {},
        ...(cwd ? { cwd } : {}),
      }),
    );
}

function recording(reply: ConsultReply = { consult_id: "consult-1", advisor_model: "openai/gpt", ahead: 1, left_this_hour: 4 }) {
  const sent: Array<{ agent_id: string; conversation_id: string; text: string }> = [];
  const folders: Array<string | undefined> = [];
  const advisor: AdvisorConsulting = {
    consult: (ref, text) => (sent.push({ ...ref, text }), Promise.resolve(reply)),
    changes: (folder) => (
      folders.push(folder),
      Promise.resolve(consultTextOf(folder, { kind: "uncommitted", files: [{ path: "a.ts", added: 2, deleted: 0 }], more: 0 }))
    ),
  };
  return { advisor, sent, folders };
}

describe("advisor_consult", () => {
  test("a loki-engine chat that calls it with a text queues a consult from the agent, and reads where it stands without a card", async () => {
    const s = await consultSetup();
    try {
      const d = s.first;
      const mods = d.chats["deps"].mods;
      await mods.load({
        name: "loki",
        apiVersion: 1,
        activate: lokiMod({ consult: (ref, text) => d.chats.consult(ref, "agent", text), changes: () => Promise.reject(new Error("a text was given")) }),
      });
      const asked = "Look at /work/a.ts: is the answer right? The person wants no new files.";
      let calls = 0;
      s.replies.chat = () =>
        ++calls === 1
          ? fauxAssistantMessage(fauxToolCall("advisor_consult", { text: asked }, { id: "consult-call" }), { stopReason: "toolUse" })
          : fauxAssistantMessage("Done.");
      await d.chats.send({ agent_id: AGENT, conversation_id: s.chatId, text: "check the answer", images: [], send_id: "w1", context: null });
      await s.settled(d);
      expect(await s.ledger(d)).toMatchObject([{ from: "agent", first_line: "Look at /work/a.ts: is the answer right? The person wants no new files." }]);
      expect(consultOf(must(s.seen.advisor[0], "the consult"))).toEqual({ from: "agent", text: asked });
      const chat = must(await d.store.chat(s.chatId, BACKGROUND_CONTEXT), "the chat");
      const result = (await d.store.entries(chat, BACKGROUND_CONTEXT)).find((e) => e.kind === "pi.tool-result");
      expect(contentText(must(result, "the tool's result").model?.[0]?.content)).toBe(
        `sent to your advisor (${s.advice}); it is working on it now; 5 of 6 consults left this hour. ` +
          "Its answer comes back as a row from your advisor and starts a new turn: do not wait or check for it; end your turn or go on with other work.",
      );
      await until(async () => (await s.answers(d)).length === 1);
    } finally {
      await s.cleanup();
    }
  });

  test("with consults ahead, the result says how many, and the model it goes to", async () => {
    const r = recording();
    const consult = consultTool(r.advisor);
    expect(await consult({ text: "is the migration safe?" })).toMatch(
      /^sent to your advisor \(openai\/gpt\); it answers after 1 consult ahead of it; 4 of 6 consults left this hour\. /,
    );
    expect(r.sent).toEqual([{ agent_id: "agent-local-ada", conversation_id: "local-conv-work", text: "is the migration safe?" }]);
  });

  test("with no text, the consult carries the change list of the chat's folder: the call's, else the one the chat list shows", async () => {
    const work = join("/", "work");
    const r = recording();
    const listed = {
      scope: "local-conv-acp",
      conversation_id: "local-conv-acp",
      agent_id: "agent-local-ada",
      status: "live",
      cwd: join("/", "acp"),
    } as DeskSummary;
    const consult = consultTool(r.advisor, () => [listed]);
    await consult({}, "local-conv-work", work);
    await consult({ text: "  " }, "local-conv-acp");
    expect(r.folders).toEqual([work, join("/", "acp")]);
    expect(r.sent.map((c) => c.text)).toEqual([
      `Review the uncommitted changes in ${work}:\n- a.ts (+2 -0)`,
      `Review the uncommitted changes in ${join("/", "acp")}:\n- a.ts (+2 -0)`,
    ]);
  });

  test("with no text and nothing to review, nothing is sent and the notice says so", async () => {
    const r = recording();
    r.advisor.changes = (folder) => Promise.resolve(consultTextOf(folder, { kind: "not_a_checkout" }));
    await expect(consultTool(r.advisor)({}, "local-conv-work", join("/", "work"))).rejects.toThrow(
      `Nothing to review: ${join("/", "work")} is not a git checkout. Nothing was sent: say in text what to look at.`,
    );
    expect(r.sent).toEqual([]);
  });

  test("from an advisor chat or a background pass it is refused with the reason, and nothing is sent", async () => {
    const r = recording();
    const consult = consultTool(r.advisor);
    await expect(consult({ text: "and you?" }, "advisor-local-conv-work")).rejects.toThrow("an advisor chat has no advisor of its own");
    await expect(consult({ text: "hm" }, "reflection-agent-local-ada")).rejects.toThrow("a background pass has no advisor");
    expect(r.sent).toEqual([]);
  });

  test("a consult the daemon refuses, past the cap, comes back as the tool's error with the reason", async () => {
    const r = recording({ refused: "this chat consulted its advisor 6 times in the last hour: wait, or tell the person, who can still ask with /advisor" });
    await expect(consultTool(r.advisor)({ text: "again?" })).rejects.toThrow(
      "not sent to your advisor: this chat consulted its advisor 6 times in the last hour: wait, or tell the person, who can still ask with /advisor",
    );
  });

  test("it never asks, in any mode", () => {
    expect(asks("strict", "advisor_consult", { text: "x" }, {})).toBe(false);
  });
});
