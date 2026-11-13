import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "../app/src/theme.tsx";
import { NewChat, type NewChatProps } from "../app/src/desk/new-chat.tsx";

// Plan 2026-11-12-1505, U20: ⌘N under Liquid Glass opens an empty chat in place, with a To: line holding the agent.
// ThemeProvider reads the palette from storage, and the new chat pane's thread its switch, so both are put there.

const noop = () => {};
let saved: Storage | undefined;
beforeEach(() => {
  saved = globalThis.localStorage;
  const stored: Record<string, string> = { "loki.palette": "apple", "loki.thread-preview": "on" };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => stored[key] ?? null, setItem: noop } });
});
afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: saved });
});

const html = (el: ReactElement) => renderToStaticMarkup(createElement(ThemeProvider, null, el));
const props: NewChatProps = {
  agents: [
    { id: "friday", name: "Friday" },
    { id: "atlas", name: "Atlas" },
  ],
  avatar: () => null,
  defaultAgentId: "atlas",
  currentAgentId: "friday",
  currentConversationKey: null,
  folders: {
    recent: () => Promise.resolve({ byAgent: {}, byConversation: {} }),
    complete: () => Promise.resolve([]),
    check: (path) => Promise.resolve({ ok: true, path, branch: null }),
    pick: () => Promise.resolve(null),
  },
  onStart: () => Promise.resolve(),
  onClose: noop,
  focusTick: 0,
};

describe("a new chat under Liquid Glass", () => {
  test("is titled New Chat, with a To: line holding the agent asked for as a token that opens a menu", () => {
    const out = html(createElement(NewChat, props));
    expect(out).toContain(">New Chat</h1>");
    expect(out).toContain(">To:</span>");
    expect(out).toMatch(/class="loki-new-chat-token"[^>]*aria-haspopup="menu"[^>]*>.*<span>Atlas<\/span><\/button>/s);
    expect(out).toContain('placeholder="Message Atlas"');
  });

  test("falls back to the first agent when the one asked for is gone, and says so when there are none", () => {
    expect(html(createElement(NewChat, { ...props, defaultAgentId: "gone" }))).toContain("<span>Friday</span>");
    const none = html(createElement(NewChat, { ...props, agents: [] }));
    expect(none).toContain("<span>No Agents</span>");
    expect(none).toMatch(/class="loki-new-chat-token"[^>]*disabled/);
  });

  test("offers the folder at the end of the To: line, and its empty thread says nothing", () => {
    const out = html(createElement(NewChat, props));
    expect(out).toMatch(/class="loki-new-chat-folder"[^>]*>Choose Folder…<\/button>/);
    expect(out).not.toContain("nothing here yet");
    expect(out).not.toContain("loading the thread");
  });
});
