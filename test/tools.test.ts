import { describe, expect, test } from "vitest";
import { registerTools, type ToolDeps } from "../mod/tools.ts";
import type { ModApi, ModTool } from "../daemon/mods/api.ts";
import { must } from "./fixtures/must.ts";
import type { ChatSummary, Suggestion } from "../core/frame-types.ts";
import { Suggestions } from "../mod/suggestions.ts";
import { asks, kindOf } from "../daemon/approvals.ts";

interface Called {
  name: string;
  description: string;
  annotations: ModTool["annotations"];
  callers: ModTool["callers"];
  run: (c: { args?: Record<string, unknown>; conversation?: { id: string }; agent?: { id: string; name: string } }) => Promise<unknown>;
}

function harness(deps?: Partial<ToolDeps>) {
  const tools = new Map<string, Called>();
  const sections = new Map<string, () => string | undefined>();
  const api = {
    tools: {
      register: (t: ModTool) => {
        tools.set(t.name, {
          name: t.name,
          description: t.description,
          annotations: t.annotations,
          callers: t.callers,
          run: async (c) =>
            await t.execute(c.args ?? {}, {
              chatId: c.conversation?.id ?? "",
              agentId: c.agent?.id ?? "",
              agentName: c.agent?.name ?? "",
              signal: new AbortController().signal,
              output: () => {},
            }),
        });
        return () => tools.delete(t.name);
      },
    },
    prompt: {
      section: (key: string, render: () => string | undefined) => {
        sections.set(key, render);
        return () => sections.delete(key);
      },
    },
  } as unknown as ModApi;
  registerTools(api, {
    ...deps,
  });
  return { tools, sections };
}

describe("the mod's tools", () => {
  test("no task_* tool and no canvas tools", () => {
    const names = [...harness().tools.keys()].sort();
    expect(names).toEqual([]);
  });

  test("chat_list is for scripts only; suggestion_create is for the model (plan 099)", () => {
    const { tools } = harness({
      chats: { suggestions: { add: () => Promise.reject(new Error("not called")) }, agents: () => [], chats: () => [], passChat: () => false },
    });
    const scriptOnly = [...tools.values()].filter((t) => t.callers?.includes("model") === false).map((t) => t.name);
    expect(scriptOnly.sort()).toEqual(["chat_list"]);
    expect(tools.get("suggestion_create")?.callers).toBeUndefined();
  });
});

describe("chat_list and the suggestion tools", () => {
  const FRIDAY = "agent-local-friday";
  const IRA = "agent-local-ira";
  const NOVA = "agent-local-nova";
  const desk = (d: Partial<ChatSummary> & { conversation_id: string; agent_id: string }): ChatSummary => ({
    scope: d.conversation_id,
    title: null,
    status: "live",
    agent_name: d.agent_id === IRA ? "Ira" : "Friday",
    model: null,
    reasoning_effort: null,
    labels: [],
    purpose: null,
    cwd: null,
    pinned: false,
    active: false,
    last_active: null,
    ...d,
  });
  const chats = [
    desk({ conversation_id: "conv-source", agent_id: FRIDAY, title: "suggestions plan", cwd: "/work/loki", last_active: "2026-10-29T09:00:00.000Z" }),
    desk({
      conversation_id: "conv-infra",
      agent_id: FRIDAY,
      title: "infra",
      cwd: "/work/infra",
      labels: ["ops"],
      pinned: true,
      purpose: "Everything about the build machines",
      last_active: "2026-10-28T10:00:00.000Z",
    }),
    desk({ conversation_id: "conv-site", agent_id: IRA, title: "site", cwd: "/work/site", home: "mac-laptop", home_name: "laptop", reachable: true }),
    desk({ conversation_id: "conv-old", agent_id: FRIDAY, title: "old notes", cwd: "/work/old", status: "archived" }),
  ];
  const agents = [
    { id: FRIDAY, name: "Friday", mac: "studio", reachable: true },
    { id: IRA, name: "Ira", mac: "laptop", reachable: true },
    { id: NOVA, name: "Nova", mac: "laptop", reachable: false },
  ];

  function suggesting() {
    const records = new Map<string, Suggestion[]>([
      [`${FRIDAY}/conv-source`, []],
      [`${FRIDAY}/conv-infra`, []],
    ]);
    let n = 0;
    const suggestions = new Suggestions({
      records: {
        read: (a, c) => Promise.resolve(records.has(`${a}/${c}`) ? { suggestions: records.get(`${a}/${c}`) ?? [], archived: false } : null),
        write: (a, c, s) => (records.set(`${a}/${c}`, s), Promise.resolve()),
      },
      chat: () => ({ title: "infra", status: "live", has_draft: false }),
      agentExists: () => true,
      call: () => Promise.resolve({ ok: true, reply: {} }),
      push: () => {},
      newId: () => `sugg-${++n}`,
      now: () => new Date("2026-10-29T10:00:00.000Z"),
    });
    const h = harness({
      chats: { suggestions, agents: () => Promise.resolve(agents), chats: () => chats, passChat: (id) => id.startsWith("reflection-") },
    });
    const run = (tool: string, args: Record<string, unknown>, conversation = "conv-source") =>
      must(h.tools.get(tool), tool).run({ args, conversation: { id: conversation }, agent: { id: FRIDAY, name: "Friday" } });
    return { run, records, suggestions, tools: h.tools };
  }

  test("suggestion_create comes with the chat listing, and nothing to list or take one back (plan 094); every name is <subject>_<verb>", () => {
    const names = [...suggesting().tools.keys()].sort();
    expect(names).toEqual(["chat_list", "suggestion_create"]);
    expect(names.filter((n) => !/^[a-z][a-z0-9]*_[a-z0-9]+$/.test(n))).toEqual([]);
  });

  test("chat_list returns structured agents and open chats across Macs, leaves out archived ones and marks the calling chat", async () => {
    const out = (await suggesting().run("chat_list", {})) as {
      agents: Array<{ id: string; name: string; mac: string; reachable: boolean }>;
      chats: Array<Record<string, unknown>>;
      links: Array<Record<string, unknown>>;
    };
    const infra = must(
      out.chats.find((c) => c.conversation_id === "conv-infra"),
      "the infra row",
    );
    expect(infra).toMatchObject({
      conversation_id: "conv-infra",
      agent_id: FRIDAY,
      agent_name: "Friday",
      title: "infra",
      cwd: "/work/infra",
      labels: ["ops"],
      pinned: true,
      last_active: "2026-10-28T10:00:00.000Z",
      purpose: "Everything about the build machines",
      this_chat: false,
    });
    expect(
      must(
        out.chats.find((c) => c.conversation_id === "conv-site"),
        "the paired Mac's row",
      ).home_name,
    ).toBe("laptop");
    expect(
      must(
        out.chats.find((c) => c.conversation_id === "conv-source"),
        "the calling chat",
      ).this_chat,
    ).toBe(true);
    expect(out.chats.some((c) => c.conversation_id === "conv-old")).toBe(false);
  });

  test("chat_list includes agents with no chats, with their Mac and reachability; a filter narrows the entries", async () => {
    const { run } = suggesting();
    const out = (await run("chat_list", {})) as { agents: Array<{ id: string; name: string; mac: string; reachable: boolean }> };
    const nova = must(
      out.agents.find((a) => a.id === NOVA),
      "Nova's row",
    );
    expect(nova).toMatchObject({ name: "Nova", mac: "laptop", reachable: false });
    const filtered = (await run("chat_list", { filter: "BUILD MACHINES" })) as { chats: Array<{ conversation_id: string }> };
    expect(filtered.chats.map((c) => c.conversation_id)).toContain("conv-infra");
    expect(filtered.chats.map((c) => c.conversation_id)).not.toContain("conv-site");
  });

  test("suggestion_create for an existing chat stores a pending suggestion on the calling chat and returns its id", async () => {
    const { run, records } = suggesting();
    const out = String(
      await run("suggestion_create", {
        title: "Fix the runner's disk",
        text: "The runner at /work/infra/runner.sh fills the disk.",
        target: { agent_id: FRIDAY, conversation_id: "conv-infra" },
      }),
    );
    expect(out).toContain("sugg-1");
    expect(records.get(`${FRIDAY}/conv-source`)).toMatchObject([
      { id: "sugg-1", title: "Fix the runner's disk", status: "pending", target: { agent_id: FRIDAY, conversation_id: "conv-infra" } },
    ]);
    await run("suggestion_create", { title: "Redo the site", text: "Rebuild /work/site.", target: { agent_id: IRA, folder: "/work/site" } });
    expect(records.get(`${FRIDAY}/conv-source`)?.[1]).toMatchObject({ target: { agent_id: IRA, folder: "/work/site" } });
  });

  test("suggestion_create for an unknown agent, chat or folder errors with the valid choices and stores nothing", async () => {
    const { run, records } = suggesting();
    const make = (target: unknown) => run("suggestion_create", { title: "t", text: "x", target });
    await expect(make({ agent_id: "agent-local-ghost", folder: "/work/loki" })).rejects.toThrow(new RegExp(`${FRIDAY}.*${IRA}.*${NOVA}`));
    await expect(make({ agent_id: FRIDAY, conversation_id: "conv-old" })).rejects.toThrow(/conv-infra/);
    await expect(make({ agent_id: FRIDAY, conversation_id: "conv-site" })).rejects.toThrow(new RegExp(IRA));
    await expect(make({ agent_id: FRIDAY, folder: "/nowhere" })).rejects.toThrow(/\/work\/infra/);
    await expect(make(undefined)).rejects.toThrow(/target/);
    expect(records.get(`${FRIDAY}/conv-source`)).toEqual([]);
  });

  test("a call from a background pass's chat fails", async () => {
    const { run } = suggesting();
    for (const tool of ["chat_list", "suggestion_create"])
      await expect(run(tool, { title: "t", text: "x", target: { agent_id: FRIDAY, conversation_id: "conv-infra" } }, "reflection-1")).rejects.toThrow(
        /background pass/,
      );
  });

  function messaging() {
    const sent: Array<{ source: unknown; target: unknown; text: string }> = [];
    const messages = {
      send: (source: { agent_id: string; conversation_id: string }, target: { agent_id: string; conversation_id: string }, text: string) => {
        sent.push({ source, target, text });
        return Promise.resolve({ ok: true, message: 'sent to "infra".' });
      },
      linksOf: () => [
        {
          id: "link-1",
          from: { agent_id: FRIDAY, conversation_id: "conv-source", title: "suggestions plan" },
          to: { agent_id: FRIDAY, conversation_id: "conv-infra", title: "infra" },
          direction: "both_ways" as const,
          created_at: "2026-11-04T10:00:00.000Z",
          expires_at: null,
        },
      ],
    };
    const h = harness({
      chats: {
        suggestions: suggesting().suggestions,
        agents: () => Promise.resolve(agents),
        chats: () => chats,
        passChat: (id) => id.startsWith("reflection-"),
        messages,
      },
    });
    const run = (tool: string, args: Record<string, unknown>, conversation = "conv-source") =>
      must(h.tools.get(tool), tool).run({ args, conversation: { id: conversation }, agent: { id: FRIDAY, name: "Friday" } });
    return { run, sent, tools: h.tools };
  }

  test("chat_message comes only with links kept, sends from the calling chat, and never asks in any mode (plan 067)", async () => {
    expect(suggesting().tools.has("chat_message")).toBe(false);
    const { run, sent, tools } = messaging();
    expect(await run("chat_message", { agent_id: FRIDAY, conversation_id: "conv-infra", text: "is the cert renewed?" })).toBe('sent to "infra".');
    expect(sent).toEqual([
      {
        source: { agent_id: FRIDAY, conversation_id: "conv-source" },
        target: { agent_id: FRIDAY, conversation_id: "conv-infra" },
        text: "is the cert renewed?",
      },
    ]);
    await expect(run("chat_message", { agent_id: IRA, conversation_id: "conv-infra", text: "x" })).rejects.toThrow(/belongs to agent/);
    await expect(run("chat_message", { agent_id: FRIDAY, conversation_id: "conv-infra", text: "x" }, "reflection-1")).rejects.toThrow(/background pass/);
    for (const mode of ["strict", "standard", "acceptEdits"] as const)
      expect(asks(mode, "chat_message", {}, { kind: kindOf("chat_message", must(tools.get("chat_message"), "chat_message").annotations) })).toBe(false);
    expect(must(tools.get("chat_message"), "chat_message").description).toMatch(/suggestion_create instead/);
  });

  test("chat_list includes this chat's links and which way each goes", async () => {
    const out = (await messaging().run("chat_list", {})) as {
      links: Array<{ agent_id: string; conversation_id: string; title: string | null; direction: string }>;
    };
    expect(out.links).toContainEqual({
      agent_id: FRIDAY,
      conversation_id: "conv-infra",
      title: "infra",
      direction: "both_ways",
      expires_at: null,
    });
  });

  test("both only read, so no mode asks; suggestion_create says when to suggest", () => {
    const { tools } = suggesting();
    for (const name of ["chat_list", "suggestion_create"])
      for (const mode of ["strict", "standard", "acceptEdits"] as const)
        expect(asks(mode, name, {}, { kind: kindOf(name, must(tools.get(name), name).annotations) })).toBe(false);
    const rule = must(tools.get("suggestion_create"), "suggestion_create").description;
    expect(rule).toMatch(/another chat/);
    expect(rule).toMatch(/never for work you can do in this chat/);
    expect(rule).toMatch(/chat_list/);
    expect(rule).toMatch(/absolute paths/);
  });
});
