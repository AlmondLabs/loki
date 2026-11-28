import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  EMPTY_PANE,
  EMPTY_ROUTE,
  activeWorkerChat,
  chatKeyTarget,
  chooseTab,
  escapeTab,
  openTab,
  paneView,
  routeTick,
  shownTab,
  stepWorkerChat,
  tabOf,
  tickFor,
} from "../app/src/workspace/pane.ts";

describe("desk pane: which tab", () => {
  test("a desk never visited shows Messages", () => {
    expect(tabOf(EMPTY_PANE, "ira/abc")).toBe("messages");
  });
  test("the tab is kept per desk", () => {
    const s = chooseTab(EMPTY_PANE, "ira/abc", "workers");
    expect(tabOf(s, "ira/abc")).toBe("workers");
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
    const s = chooseTab(chooseTab(EMPTY_PANE, "ira/abc", "messages"), "friday/xyz", "workers");
    expect(tabOf(s, "friday/xyz")).toBe("workers");
    expect(tabOf(s, "ira/abc")).toBe("messages");
  });
});

describe("desk pane: the tab shown", () => {
  test("Workers shows only while the chat has workers; Messages shows as stored", () => {
    expect(shownTab("workers", true)).toBe("workers");
    expect(shownTab("workers", false)).toBe("messages");
    expect(shownTab("messages", true)).toBe("messages");
  });
  test("stored Workers with no workers known: keys reach Messages and Esc is not the pane's", () => {
    const shown = shownTab("workers", false);
    expect(chatKeyTarget("chat.mode", shown)).toBe("messages");
    expect(escapeTab(chooseTab(EMPTY_PANE, "ira/abc", "workers"), "ira/abc", shown, { typing: false })).toBeNull();
  });
});

describe("desk pane: Esc", () => {
  const onWorkers = chooseTab(EMPTY_PANE, "ira/abc", "workers");
  test("Esc on the Workers tab goes back to Messages", () => {
    const s = escapeTab(onWorkers, "ira/abc", "workers", { typing: false });
    expect(s && tabOf(s, "ira/abc")).toBe("messages");
  });
  test("Esc while typing belongs to the box", () => {
    expect(escapeTab(onWorkers, "ira/abc", "workers", { typing: true })).toBeNull();
  });
  test("Esc on Messages is not the pane's", () => {
    expect(escapeTab(EMPTY_PANE, "ira/abc", "messages", { typing: false })).toBeNull();
  });
});

describe("desk pane: the sidebar", () => {
  test("no tab hides the sidebar: it stays visible across views (plan 2026-11-14-1130, 2)", () => {
    const shell = readFileSync(new URL("../app/src/shell/shell.tsx", import.meta.url), "utf8");
    expect(shell).not.toMatch(/sidebarHidden|immersive/);
    expect(shell).toMatch(/const sidebarShown = layout\.sidebarShown;/);
  });
});

describe("desk pane: the visible view", () => {
  test("Messages, the Workers tab, or nothing when another section shows", () => {
    expect(paneView(true, "messages")).toBe("messages");
    expect(paneView(true, "workers")).toBe("workers");
    expect(paneView(false, "messages")).toBeNull();
    expect(paneView(false, "workers")).toBeNull();
  });
});

describe("desk pane: chat keys act on the visible view", () => {
  test("⌘L, ⌘F, ⌘⇧M, ⌘⇧P and ⌘⇧S reach Messages", () => {
    for (const id of ["chat.focus", "chat.find", "chat.model", "chat.mode", "chat.suggestions"]) {
      expect(chatKeyTarget(id, "messages")).toBe("messages");
    }
  });
  test("on the Workers tab, ⌘L, ⌘F and ⌘⇧M reach workers; mode and suggestions reach nothing", () => {
    for (const id of ["chat.focus", "chat.find", "chat.model"]) expect(chatKeyTarget(id, "workers")).toBe("workers");
    for (const id of ["chat.mode", "chat.suggestions"]) expect(chatKeyTarget(id, "workers")).toBeNull();
  });
});

describe("desk pane: ticks reach only the view that showed when they were bumped", () => {
  test("a bump goes to the visible view", () => {
    const r = routeTick(EMPTY_ROUTE, 1, "messages", "a");
    expect(tickFor(r, "messages")).toBe(1);
    expect(tickFor(r, "workers")).toBe(0);
  });
  test("switching views without a bump delivers nothing, so a remount does not replay it", () => {
    let r = routeTick(EMPTY_ROUTE, 3, "messages", "a");
    r = routeTick(r, 3, "workers", "a");
    expect(tickFor(r, "workers")).toBe(0);
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

describe("desk pane: hidden behind other sections", () => {
  test("the Messages panel inherits visibility, never forces it on", () => {
    const src = readFileSync(new URL("../app/src/workspace/canvas-pane.tsx", import.meta.url), "utf8");
    const panels = src.match(/visibility: tab === "messages" \? "[a-z]+"/g) ?? [];
    expect(panels).toHaveLength(1);
    for (const p of panels) expect(p.endsWith('"inherit"')).toBe(true);
  });
});

describe("desk pane: the hidden tab hides all of it", () => {
  test("nothing in workspace marks itself visible, which would show through Messages", () => {
    const dir = new URL("../app/src/workspace/", import.meta.url);
    const marked = readdirSync(dir)
      .filter((f) => /\.(tsx?|css)$/.test(f))
      .filter((f) => /visibility:[^,;}\n]*(["'])visible\1|visibility:\s*visible\s*[;}]/.test(readFileSync(new URL(f, dir), "utf8")));
    expect(marked).toEqual([]);
  });

  test("the Workers panel starts below the pane header rather than sharing Messages' header overlap class", () => {
    const src = readFileSync(new URL("../app/src/workspace/canvas-pane.tsx", import.meta.url), "utf8");
    expect(src).toContain('id={panelId("workers")}');
    expect(src).toContain("loki-canvas-pane-workers");
    expect(src.match(/loki-canvas-pane-messages/g)).toHaveLength(1);
  });
});

describe("desk pane: stepping between workers", () => {
  const workers = [
    { chat_id: "c1~subagent~kestrel", status: "done" },
    { chat_id: "c1~subagent~ember", status: "running" },
    { chat_id: "c1~subagent~atlas", status: "done" },
  ];

  test("activeWorkerChat prefers the selected chat, then running, then the first", () => {
    expect(activeWorkerChat(workers, "c1~subagent~atlas")).toBe("c1~subagent~atlas");
    expect(activeWorkerChat(workers, "missing")).toBe("c1~subagent~ember");
    expect(activeWorkerChat(workers, null)).toBe("c1~subagent~ember");
    expect(activeWorkerChat([], null)).toBeNull();
  });

  test("stepWorkerChat wraps backward and forward from the active worker", () => {
    expect(stepWorkerChat(workers, "c1~subagent~kestrel", 1)).toBe("c1~subagent~ember");
    expect(stepWorkerChat(workers, "c1~subagent~kestrel", -1)).toBe("c1~subagent~atlas");
    expect(stepWorkerChat(workers, "c1~subagent~atlas", 1)).toBe("c1~subagent~kestrel");
    expect(stepWorkerChat(workers, null, 1)).toBe("c1~subagent~atlas");
    expect(stepWorkerChat([], null, 1)).toBeNull();
  });
});
