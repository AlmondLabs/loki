import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  EMPTY_PANE,
  EMPTY_ROUTE,
  agentState,
  chatKeyTarget,
  chooseTab,
  escapeTab,
  nextFrame,
  openTab,
  paneView,
  routeTick,
  shownTab,
  tabOf,
  tickFor,
} from "../app/src/workspace/pane.ts";
import { createDrafts, draftKey } from "../app/src/shared/drafts.ts";
import { draftWriter } from "../app/src/chat/use-draft.ts";

describe("desk pane: which tab", () => {
  test("a desk never visited shows Messages", () => {
    expect(tabOf(EMPTY_PANE, "ira/abc")).toBe("messages");
  });
  test("the tab is kept per desk", () => {
    const s = chooseTab(EMPTY_PANE, "ira/abc", "canvas");
    expect(tabOf(s, "ira/abc")).toBe("canvas");
    expect(tabOf(s, "friday/xyz")).toBe("messages");
  });
  test("opening a desk from anywhere lands on Messages, even one left on the Desk tab (AE1)", () => {
    const s = openTab(chooseTab(EMPTY_PANE, "ira/abc", "canvas"), "ira/abc");
    expect(tabOf(s, "ira/abc")).toBe("messages");
  });
  test("a switch that is not an open (⌘[ ⌘], the mod's switch_chat) reads the desk's own tab", () => {
    const s = chooseTab(EMPTY_PANE, "ira/abc", "canvas");
    expect(tabOf(s, "ira/abc")).toBe("canvas");
    expect(tabOf(s, "friday/xyz")).toBe("messages");
  });
  test("choosing the tab already showing returns the same state", () => {
    expect(chooseTab(EMPTY_PANE, "ira/abc", "messages")).toBe(EMPTY_PANE);
  });
  test("opening a chat left on Workers lands on Messages; a switch that is not an open reads Workers", () => {
    const left = chooseTab(EMPTY_PANE, "ira/abc", "workers");
    expect(tabOf(openTab(left, "ira/abc"), "ira/abc")).toBe("messages");
    expect(tabOf(left, "ira/abc")).toBe("workers");
  });
  test("choosing Workers for another chat leaves the current one's tab alone", () => {
    const s = chooseTab(chooseTab(EMPTY_PANE, "ira/abc", "canvas"), "friday/xyz", "workers");
    expect(tabOf(s, "friday/xyz")).toBe("workers");
    expect(tabOf(s, "ira/abc")).toBe("canvas");
  });
});

describe("desk pane: the tab shown", () => {
  test("Workers shows only while the chat has workers; Messages and Canvas show as stored", () => {
    expect(shownTab("workers", true)).toBe("workers");
    expect(shownTab("workers", false)).toBe("messages");
    expect(shownTab("canvas", false)).toBe("canvas");
    expect(shownTab("messages", true)).toBe("messages");
  });
  test("stored Workers with no workers known: keys reach Messages and Esc is not the pane's", () => {
    const shown = shownTab("workers", false);
    expect(chatKeyTarget("chat.mode", shown)).toBe("messages");
    expect(escapeTab(chooseTab(EMPTY_PANE, "ira/abc", "workers"), "ira/abc", shown, { typing: false })).toBeNull();
  });
});

describe("desk pane: Esc", () => {
  const onDesk = chooseTab(EMPTY_PANE, "ira/abc", "canvas");
  const onWorkers = chooseTab(EMPTY_PANE, "ira/abc", "workers");
  test("Esc on the Desk tab goes back to Messages", () => {
    const s = escapeTab(onDesk, "ira/abc", "canvas", { typing: false });
    expect(s && tabOf(s, "ira/abc")).toBe("messages");
  });
  test("Esc on the Workers tab goes back to Messages", () => {
    const s = escapeTab(onWorkers, "ira/abc", "workers", { typing: false });
    expect(s && tabOf(s, "ira/abc")).toBe("messages");
  });
  test("Esc while typing belongs to the box", () => {
    expect(escapeTab(onDesk, "ira/abc", "canvas", { typing: true })).toBeNull();
    expect(escapeTab(onWorkers, "ira/abc", "workers", { typing: true })).toBeNull();
  });
  test("Esc on Messages is not the pane's", () => {
    expect(escapeTab(EMPTY_PANE, "ira/abc", "messages", { typing: false })).toBeNull();
  });
});

describe("desk pane: the sidebar", () => {
  test("no tab hides the sidebar: the Canvas tab keeps it, as Finder keeps its sidebar in every view (plan 2026-11-14-1130, 2)", () => {
    const shell = readFileSync(new URL("../app/src/shell/shell.tsx", import.meta.url), "utf8");
    expect(shell).not.toMatch(/sidebarHidden|immersive/);
    expect(shell).toMatch(/const sidebarShown = layout\.sidebarShown;/);
  });
});

describe("desk pane: the visible view", () => {
  test("Messages, the Workers tab, the Desk tab's inset, or nothing when another section shows", () => {
    expect(paneView(true, "messages")).toBe("messages");
    expect(paneView(true, "workers")).toBe("workers");
    expect(paneView(true, "canvas")).toBe("inset");
    expect(paneView(false, "messages")).toBeNull();
    expect(paneView(false, "workers")).toBeNull();
  });
});

describe("desk pane: chat keys act on the visible view", () => {
  test("⌘L, ⌘F, ⌘⇧M, ⌘⇧P and ⌘⇧S reach Messages on Messages, the inset on the Desk tab", () => {
    for (const id of ["chat.focus", "chat.find", "chat.model", "chat.mode", "chat.suggestions"]) {
      expect(chatKeyTarget(id, "messages")).toBe("messages");
      expect(chatKeyTarget(id, "canvas")).toBe("inset");
    }
  });
  test("the inset's own keys (⌘/, ⌘W, ⌘← ⌘→) do nothing on Messages", () => {
    for (const id of ["chat.toggle", "chat.close", "chat.left", "chat.right"]) {
      expect(chatKeyTarget(id, "messages")).toBeNull();
      expect(chatKeyTarget(id, "canvas")).toBe("inset");
    }
  });
  test("on the Workers tab, ⌘L, ⌘F and ⌘⇧M reach workers; mode, suggestions and the inset's keys reach nothing", () => {
    for (const id of ["chat.focus", "chat.find", "chat.model"]) expect(chatKeyTarget(id, "workers")).toBe("workers");
    for (const id of ["chat.mode", "chat.suggestions", "chat.toggle", "chat.close", "chat.left", "chat.right"]) expect(chatKeyTarget(id, "workers")).toBeNull();
  });
});

describe("desk pane: ticks reach only the view that showed when they were bumped", () => {
  test("a bump goes to the visible view", () => {
    const r = routeTick(EMPTY_ROUTE, 1, "messages", "a");
    expect(tickFor(r, "messages")).toBe(1);
    expect(tickFor(r, "inset")).toBe(0);
  });
  test("switching views without a bump delivers nothing, so a remount does not replay it", () => {
    let r = routeTick(EMPTY_ROUTE, 3, "messages", "a");
    r = routeTick(r, 3, "inset", "a");
    expect(tickFor(r, "inset")).toBe(0);
    r = routeTick(r, 3, "messages", "a");
    expect(tickFor(r, "messages")).toBe(0);
  });
  test("opening from the Flow: the segment and the bump change together, and Messages gets it", () => {
    let r = routeTick(EMPTY_ROUTE, 2, null, "a");
    r = routeTick(r, 3, "messages", "a");
    expect(tickFor(r, "messages")).toBe(3);
  });
  test("switching chats without a bump delivers nothing, so ⌘K does not reopen in the next chat", () => {
    let r = routeTick(EMPTY_ROUTE, 1, "messages", "a");
    r = routeTick(r, 1, "messages", "b");
    expect(tickFor(r, "messages")).toBe(0);
    r = routeTick(r, 1, "messages", "a");
    expect(tickFor(r, "messages")).toBe(0);
  });
  test("opening another chat with a bump delivers it there", () => {
    let r = routeTick(EMPTY_ROUTE, 1, "messages", "a");
    r = routeTick(r, 2, "messages", "b");
    expect(tickFor(r, "messages")).toBe(2);
  });
  test("a bump on Workers reaches workers only, and going to Messages without one delivers nothing", () => {
    let r = routeTick(EMPTY_ROUTE, 1, "workers", "a");
    expect(tickFor(r, "workers")).toBe(1);
    expect(tickFor(r, "messages")).toBe(0);
    r = routeTick(r, 1, "messages", "a");
    expect(tickFor(r, "messages")).toBe(0);
  });
  test("an unchanged render keeps the same route", () => {
    const r = routeTick(EMPTY_ROUTE, 1, "messages", "a");
    expect(routeTick(r, 1, "messages", "a")).toBe(r);
  });
});

describe("desk pane: the frame request (for widget rows)", () => {
  test("each request is new, even for the same widget", () => {
    const a = nextFrame(null, "ira/revenue");
    const b = nextFrame(a, "ira/revenue");
    expect(a).toEqual({ widgetId: "ira/revenue", nonce: 1 });
    expect(b.nonce).toBe(2);
  });
});

describe("desk pane: one draft for both views (AE3)", () => {
  test("a draft typed on Messages is the inset's draft, and back", () => {
    const store = createDrafts();
    const key = draftKey("agent-1", "conv-1");
    const messages = { current: store.get(key) };
    draftWriter(messages, (d) => store.set(key, d)).setText("half a reply");
    expect(store.get(key).text).toBe("half a reply");
    const inset = { current: store.get(key) };
    draftWriter(inset, (d) => store.set(key, d)).setText("half a reply, finished");
    expect(store.get(key).text).toBe("half a reply, finished");
  });
  test("both views hear a change on the one key", () => {
    const store = createDrafts();
    const key = draftKey("agent-1", "conv-1");
    let heard = 0;
    const offA = store.subscribe(key, () => heard++);
    const offB = store.subscribe(key, () => heard++);
    store.set(key, { text: "x", images: [] });
    expect(heard).toBe(2);
    offA();
    offB();
  });
  test("a send from either view clears it for both", () => {
    const store = createDrafts();
    const key = draftKey("agent-1", "conv-1");
    store.set(key, { text: "go", images: [] });
    const latest = { current: store.get(key) };
    draftWriter(latest, (d) => store.set(key, d)).clear();
    expect(store.get(key).text).toBe("");
  });
});

describe("desk pane: the agent pill's live state", () => {
  test("what waits on you first, then what it is doing; nothing when idle", () => {
    expect(agentState({ status: "streaming", approval: {}, question: null })).toBe("needs approval");
    expect(agentState({ status: "idle", approval: null, question: {} })).toBe("asked you");
    expect(agentState({ status: "streaming", approval: null, question: null })).toBe("writing");
    expect(agentState({ status: "thinking", approval: null, question: null })).toBe("working");
    expect(agentState({ status: "idle", approval: null, question: null })).toBeNull();
  });
});

describe("messages: copy under every message", () => {
  const rows = [
    { role: "user" as const, text: "make the chart weekly" },
    { role: "assistant" as const, text: "done — see the chart" },
    { role: "assistant" as const, text: "still writing" },
  ];
  const people = { user: { name: "You" }, assistant: { name: "ira" } };
  test("yours and the agent's each carry a copy button under them; the one still streaming waits until it is done", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { Transcript } = await import("../app/src/chat/transcript.tsx");
    const done = renderToStaticMarkup(createElement(Transcript, { rows, people }));
    expect(done.match(/class="loki-msg-actions"/g)?.length).toBe(3);
    expect(done).toContain('aria-label="Copy as Markdown"');
    expect(done).not.toContain('role="toolbar"');
    const streaming = renderToStaticMarkup(createElement(Transcript, { rows, people, streaming: true }));
    expect(streaming.match(/class="loki-msg-actions"/g)?.length).toBe(2);
  });
});

describe("desk pane: hidden behind other sections", () => {
  test("the tab panels inherit visibility, never force it on", () => {
    const src = readFileSync(new URL("../app/src/workspace/canvas-pane.tsx", import.meta.url), "utf8");
    const panels = src.match(/visibility: tab === "(messages|canvas)" \? "[a-z]+"/g) ?? [];
    expect(panels).toHaveLength(2);
    for (const p of panels) expect(p.endsWith('"inherit"')).toBe(true);
  });
});

describe("desk pane: the hidden tab hides all of it", () => {
  test("nothing on the Canvas marks itself visible, which would show through Messages", () => {
    const dir = new URL("../app/src/workspace/", import.meta.url);
    const marked = readdirSync(dir)
      .filter((f) => /\.(tsx?|css)$/.test(f))
      .filter((f) => /visibility:[^,;}\n]*(["'])visible\1|visibility:\s*visible\s*[;}]/.test(readFileSync(new URL(f, dir), "utf8")));
    expect(marked).toEqual([]);
  });
});
