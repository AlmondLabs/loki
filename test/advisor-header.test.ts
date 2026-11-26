import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AdvisorView } from "../core/advisor.ts";
import { applyChatEvent, emptyLive, type ChatEvent } from "../core/attention/model.ts";
import type { ChatState } from "../core/frames.ts";
import { AdvisorHeader, advisorTabStatus } from "../app/src/chat/advisor-header.tsx";
import { TabRow, type Tab } from "../app/src/components/index.tsx";
import { paneTabs } from "../app/src/workspace/canvas-pane.tsx";
import { OpenAdvisor } from "../app/src/chat/transcript.tsx";
import { AdvisorStrips, withAdvisorOnOpen } from "../mod/chat-advisor.ts";
import type { ChatBackend } from "../mod/frames/chat.ts";

const IDLE: AdvisorView = { advisor_chat: "advisor-c1", model: "openai/gpt-6", working: false, waiting: 0, last_failure: null };

const strip = (advisor: AdvisorView | null, open: ((advisorChat: string) => void) | null = () => {}) =>
  renderToStaticMarkup(createElement(OpenAdvisor.Provider, { value: open }, createElement(AdvisorHeader, { advisor })));

describe("the advisor strip (R23)", () => {
  test("a chat with no advisor shows no strip; one with an advisor shows it idle, with its model", () => {
    expect(strip(null)).toBe("");
    const html = strip(IDLE);
    expect(html).toMatch(/<button[^>]*aria-label="Advisor · gpt-6: open the advisor chat"[^>]*>/);
    expect(html).toContain("Advisor · gpt-6");
    expect(html).toContain('data-state="idle"');
  });

  test("working with two waiting says so; the words carry the state, not only the colour", () => {
    const html = strip({ ...IDLE, working: true, waiting: 2 });
    expect(html).toContain("Advisor is answering · 2 waiting");
    expect(html).toContain('aria-label="Advisor is answering · 2 waiting: open the advisor chat"');
    expect(html).toContain('data-state="working"');
    expect(strip({ ...IDLE, working: true })).toContain("Advisor is answering<");
  });

  test("a failure shows until the next answer, with why in its label", () => {
    const failed = strip({ ...IDLE, last_failure: "it could not reach its model (timed out)" });
    expect(failed).toContain("Advisor couldn&#x27;t answer");
    expect(failed).toContain('data-state="failed"');
    expect(failed).toContain("Advisor couldn&#x27;t answer: it could not reach its model (timed out). Open the advisor chat");
    expect(strip({ ...IDLE, last_failure: null })).toContain("Advisor · gpt-6");
  });

  test("where nothing can open the advisor chat, the strip still says its state but is no button", () => {
    const html = strip(IDLE, null);
    expect(html).toContain("Advisor · gpt-6");
    expect(html).not.toContain("<button");
  });

  test("on the Mac, a chat with an advisor gets Messages, Advisor, Canvas; one without keeps two tabs", () => {
    expect(paneTabs(null).map((t) => t.label)).toEqual(["Messages", "Canvas"]);
    expect(paneTabs(IDLE).map((t) => t.label)).toEqual(["Messages", "Advisor", "Canvas"]);
    expect(paneTabs(IDLE)[1]).toMatchObject({ id: "advisor", status: { words: "Advisor · gpt-6" } });
  });
});

describe("the Advisor tab carries the advisor's state (plan 2026-11-24-1641, R3)", () => {
  const row = (tabs: readonly Tab[]) => renderToStaticMarkup(createElement(TabRow<string>, { label: "Views", tabs, current: "messages", onChange: () => {} }));
  const advisorTab = (advisor: AdvisorView): Tab => ({ id: "advisor", label: "Advisor", status: advisorTabStatus(advisor) });
  const trigger = (html: string) => /<button[^>]*>.*?Advisor.*?<\/button>/.exec(html)?.[0] ?? "";

  test("a tab with no status renders as before", () => {
    const html = row([
      { id: "messages", label: "Messages" },
      { id: "desk", label: "Canvas" },
    ]);
    expect(html).not.toContain("title=");
    expect(html).not.toContain("aria-describedby");
    expect(html).not.toContain("loki-icon");
  });

  test("idle: no mark, the model in its tooltip and description", () => {
    const html = trigger(row([advisorTab(IDLE)]));
    expect(html).toContain('title="Advisor · gpt-6"');
    const described = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(described).toBeTruthy();
    expect(html).toContain(`id="${String(described)}" hidden="">Advisor · gpt-6</span>`);
    expect(html).not.toContain("loki-icon");
  });

  test("working with two waiting: a mark, and the words in tooltip and description", () => {
    const html = row([advisorTab({ ...IDLE, working: true, waiting: 2 })]);
    expect(trigger(html)).toContain('title="Advisor is answering · 2 waiting"');
    expect(trigger(html)).toContain('data-state="working"');
    expect(html).toMatch(/<span[^>]*id="[^"]+"[^>]*>Advisor is answering · 2 waiting<\/span>/);
  });

  test("a failure: a warning mark, with why in tooltip and description", () => {
    const html = trigger(row([advisorTab({ ...IDLE, last_failure: "it was stopped" })]));
    expect(html).toContain('data-state="failed"');
    expect(html).toContain('title="Advisor couldn&#x27;t answer: it was stopped"');
  });
});

describe("the advisor field on a chat's state (KTD10)", () => {
  test("the event sets it whole, and a later one replaces it", () => {
    const l = emptyLive();
    expect(applyChatEvent(l, { kind: "advisor", advisor: IDLE }).changed).toBe(true);
    expect(l.advisor).toEqual(IDLE);
    applyChatEvent(l, { kind: "advisor", advisor: { ...IDLE, working: true, waiting: 1 } });
    expect(l.advisor).toMatchObject({ working: true, waiting: 1 });
    applyChatEvent(l, { kind: "advisor", advisor: null });
    expect(l.advisor).toBeNull();
  });

  const backend = (views: Map<string, AdvisorView | null>) => {
    const listeners: Array<(agentId: string, chatId: string) => void> = [];
    const asked: string[] = [];
    const pending: Array<() => void> = [];
    const b = {
      open: (agentId: string, conversationId: string): Promise<ChatState> =>
        Promise.resolve({ agent_id: agentId, conversation_id: conversationId, loop: "idle", mode: null, cwd: null }),
      advisorView: (_agentId: string, chatId: string) => {
        asked.push(chatId);
        const view = views.get(chatId) ?? null;
        return new Promise<AdvisorView | null>((resolve) => pending.push(() => resolve(view)));
      },
      onAdvisorChange: (listener: (agentId: string, chatId: string) => void) => {
        listeners.push(listener);
        return () => void listeners.splice(listeners.indexOf(listener), 1);
      },
    };
    const settle = async () => {
      while (pending.length) pending.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    };
    return { b, listeners, asked, settle, change: (chatId: string) => listeners.forEach((l) => l("ada", chatId)) };
  };

  test("a chat opens with its advisor; an advisor chat opens with none and is not looked up", async () => {
    const f = backend(new Map([["c1", IDLE]]));
    const opened = withAdvisorOnOpen(f.b as unknown as ChatBackend);
    const state = opened.open("ada", "c1", null);
    await f.settle();
    expect(await state).toMatchObject({ conversation_id: "c1", advisor: IDLE });
    expect(await opened.open("ada", "advisor-c1", null)).toMatchObject({ advisor: null });
    expect(f.asked).toEqual(["c1"]);
  });

  test("every change is pushed whole to the chat, and the advisor chat's own turns move it too", async () => {
    const views = new Map<string, AdvisorView | null>([["c1", IDLE]]);
    const f = backend(views);
    const pushed: Array<[string, string, ChatEvent[]]> = [];
    const strips = new AdvisorStrips(f.b, (agentId, chatId, events) => pushed.push([agentId, chatId, events]));
    const stop = strips.start();
    views.set("c1", { ...IDLE, working: true, waiting: 2 });
    f.change("c1");
    await f.settle();
    expect(pushed).toEqual([["ada", "c1", [{ kind: "advisor", advisor: { ...IDLE, working: true, waiting: 2 } }]]]);
    views.set("c1", { ...IDLE, working: true });
    strips.heard("ada", "advisor-c1", [{ kind: "loop", state: "running" }]);
    strips.heard("ada", "advisor-c1", [{ kind: "step", step: { kind: "assistant", text: "x", at: null, chunk: true } }]);
    strips.heard("ada", "c1", [{ kind: "loop", state: "running" }]);
    await f.settle();
    expect(pushed.at(-1)).toEqual(["ada", "c1", [{ kind: "advisor", advisor: { ...IDLE, working: true } }]]);
    expect(f.asked).toEqual(["c1", "c1"]);
    stop();
    expect(f.listeners).toHaveLength(0);
  });

  test("of two lookups in flight, only the newer is pushed", async () => {
    const views = new Map<string, AdvisorView | null>([["c1", IDLE]]);
    const f = backend(views);
    const pushed: ChatEvent[][] = [];
    const strips = new AdvisorStrips(f.b, (_a, _c, events) => pushed.push(events));
    strips.start();
    f.change("c1");
    views.set("c1", { ...IDLE, last_failure: "it was stopped" });
    f.change("c1");
    await f.settle();
    expect(pushed).toEqual([[{ kind: "advisor", advisor: { ...IDLE, last_failure: "it was stopped" } }]]);
  });
});
