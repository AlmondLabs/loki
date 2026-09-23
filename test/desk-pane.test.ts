import { describe, expect, test } from "bun:test";
import { EMPTY_PANE, EMPTY_ROUTE, agentState, chatKeyTarget, chooseTab, escapeTab, nextFrame, openTab, paneView, routeTick, sidebarHidden, tabOf, tickFor } from "../app/src/desk/pane.ts";
import { createDrafts, draftKey } from "../app/src/shared/drafts.ts";
import { draftWriter } from "../app/src/chat/useDraft.ts";

/**
 * The desk pane (plan 013 U5): a desk opens as a Slack channel on its Messages tab; the Desk tab is today's
 * canvas with the inset chat. The tab is kept per desk, every open lands on Messages, Esc on the Desk tab
 * comes back, and the chat keys and the host's ticks reach only the view that shows.
 */

describe("desk pane: which tab", () => {
  test("a desk never visited shows Messages", () => {
    expect(tabOf(EMPTY_PANE, "ira/abc")).toBe("messages");
  });
  test("the tab is kept per desk", () => {
    const s = chooseTab(EMPTY_PANE, "ira/abc", "desk");
    expect(tabOf(s, "ira/abc")).toBe("desk");
    expect(tabOf(s, "friday/xyz")).toBe("messages");
  });
  test("opening a desk from anywhere lands on Messages, even one left on the Desk tab (AE1)", () => {
    const s = openTab(chooseTab(EMPTY_PANE, "ira/abc", "desk"), "ira/abc");
    expect(tabOf(s, "ira/abc")).toBe("messages");
  });
  test("a switch that is not an open (⌘[ ⌘], the mod's switch_desk) reads the desk's own tab", () => {
    const s = chooseTab(EMPTY_PANE, "ira/abc", "desk");
    // nothing to call: the pane shows tabOf(state, the new scope)
    expect(tabOf(s, "ira/abc")).toBe("desk");
    expect(tabOf(s, "friday/xyz")).toBe("messages");
  });
  test("choosing the tab already showing returns the same state", () => {
    expect(chooseTab(EMPTY_PANE, "ira/abc", "messages")).toBe(EMPTY_PANE);
  });
});

describe("desk pane: Esc", () => {
  const onDesk = chooseTab(EMPTY_PANE, "ira/abc", "desk");
  test("Esc on the Desk tab goes back to Messages", () => {
    const s = escapeTab(onDesk, "ira/abc", { typing: false });
    expect(s && tabOf(s, "ira/abc")).toBe("messages");
  });
  test("Esc while typing belongs to the box", () => {
    expect(escapeTab(onDesk, "ira/abc", { typing: true })).toBeNull();
  });
  test("Esc on Messages is not the pane's", () => {
    expect(escapeTab(EMPTY_PANE, "ira/abc", { typing: false })).toBeNull();
  });
});

describe("desk pane: the sidebar", () => {
  test("the Desk tab hides the sidebar; Messages and other sections keep it (AE6)", () => {
    expect(sidebarHidden("desk", "desk")).toBe(true);
    expect(sidebarHidden("desk", "messages")).toBe(false);
    expect(sidebarHidden("board", "desk")).toBe(false);
  });
});

describe("desk pane: the visible view", () => {
  test("Messages, the Desk tab's inset, or nothing when another section shows", () => {
    expect(paneView(true, "messages")).toBe("messages");
    expect(paneView(true, "desk")).toBe("inset");
    expect(paneView(false, "messages")).toBeNull();
  });
});

describe("desk pane: chat keys act on the visible view", () => {
  test("⌘L, ⌘F, ⌘⇧M and ⌘⇧P reach Messages on Messages, the inset on the Desk tab", () => {
    for (const id of ["chat.focus", "chat.find", "chat.model", "chat.mode"]) {
      expect(chatKeyTarget(id, "messages")).toBe("messages");
      expect(chatKeyTarget(id, "desk")).toBe("inset");
    }
  });
  test("the inset's own keys (⌘/, ⌘W, ⌘← ⌘→) do nothing on Messages", () => {
    for (const id of ["chat.toggle", "chat.close", "chat.left", "chat.right"]) {
      expect(chatKeyTarget(id, "messages")).toBeNull();
      expect(chatKeyTarget(id, "desk")).toBe("inset");
    }
  });
});

describe("desk pane: ticks reach only the view that showed when they were bumped", () => {
  test("a bump goes to the visible view", () => {
    const r = routeTick(EMPTY_ROUTE, 1, "messages");
    expect(tickFor(r, "messages")).toBe(1);
    expect(tickFor(r, "inset")).toBe(0);
  });
  test("switching views without a bump delivers nothing, so a remount does not replay it", () => {
    let r = routeTick(EMPTY_ROUTE, 3, "messages");
    r = routeTick(r, 3, "inset");
    expect(tickFor(r, "inset")).toBe(0);
    r = routeTick(r, 3, "messages");
    expect(tickFor(r, "messages")).toBe(0);
  });
  test("opening from the Inbox: the segment and the bump change together, and Messages gets it", () => {
    let r = routeTick(EMPTY_ROUTE, 2, null); // in the Inbox: nothing visible
    r = routeTick(r, 3, "messages");
    expect(tickFor(r, "messages")).toBe(3);
  });
  test("an unchanged render keeps the same route", () => {
    const r = routeTick(EMPTY_ROUTE, 1, "messages");
    expect(routeTick(r, 1, "messages")).toBe(r);
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
    // Messages writes through the box's writer, the way Conversation does
    const messages = { current: store.get(key) };
    draftWriter(messages, (d) => store.set(key, d)).setText("half a reply");
    // the Desk tab's inset reads the same key
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

describe("desk pane: the hover toolbar holds only what loki does to a message", () => {
  const rows = [{ role: "assistant" as const, text: "done — see the chart" }];
  const people = { user: { name: "You" }, assistant: { name: "ira" } };
  test("the Messages tab's rows carry a copy action; the phone's layout (no toolbar) does not", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { Transcript } = await import("../app/src/chat/Transcript.tsx");
    const on = renderToStaticMarkup(createElement(Transcript, { rows, people, toolbar: true }));
    expect(on).toContain('role="toolbar"');
    expect(on).toContain('aria-label="copy as markdown"');
    expect(renderToStaticMarkup(createElement(Transcript, { rows, people }))).not.toContain('role="toolbar"');
  });
});

describe("desk pane: hidden behind other sections", () => {
  // The shell hides the whole pane with visibility while the Inbox or Board shows; a panel that set itself
  // "visible" overrode that, and the thread's day pills showed through the Inbox (U13).
  test("the tab panels inherit visibility, never force it on", async () => {
    const src = await Bun.file(new URL("../app/src/desk/DeskPane.tsx", import.meta.url)).text();
    const panels = src.match(/visibility: tab === "(messages|desk)" \? "[a-z]+"/g) ?? [];
    expect(panels).toHaveLength(2);
    for (const p of panels) expect(p).toEndWith('"inherit"');
  });
});
