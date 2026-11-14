import { describe, expect, test } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "../app/src/theme.tsx";
import { Composer, type ComposerProps } from "../app/src/item/composer.tsx";
import { matchModes } from "../app/src/shell/search-sheet.tsx";
import type { SharedModes } from "../app/src/shell/command-center.ts";

// Plan 2026-11-12-1505, U21: on the desktop the message box is Messages': "+" outside a one-line capsule, one round
// button inside it, no pills. The model and the permission mode change rarely, so ⌘K is their one home (⌘⇧M, ⌘⇧P),
// with no second control in the box or the toolbar. Typing, the menus and the keys are checked in the app.

const noop = () => {};
const html = (el: ReactElement) => renderToStaticMarkup(createElement(ThemeProvider, null, el));
const box = (over: Partial<ComposerProps> = {}) =>
  createElement(Composer, {
    value: "",
    onChange: noop,
    onSubmit: noop,
    onImages: noop,
    canSend: false,
    sendLabel: "Send",
    placeholder: "Message Friday",
    tools: createElement("span", { "data-pill": true }, "Sonnet"),
    ...over,
  });

describe("the message box", () => {
  test("is one capsule with + outside it, and draws no pills in it", () => {
    const out = html(box());
    expect(out).toContain('data-composer="messages"');
    expect(out).toContain("loki-composer-capsule");
    expect(out).not.toContain("data-pill");
    // "+" comes before the capsule, outside it, and only attaches files: no menu of model or mode.
    expect(out.indexOf("loki-composer-plus")).toBeLessThan(out.indexOf("loki-composer-capsule"));
    expect(out).toMatch(/class="loki-composer-plus"[^>]*aria-label="Attach Files"/);
    expect(out).not.toContain('aria-haspopup="menu"');
  });

  test("shows send, the up-arrow, only once there is something to send", () => {
    expect(html(box())).not.toContain('data-kind="send"');
    const typed = html(box({ value: "hello", canSend: true }));
    expect(typed).toMatch(/data-kind="send"[^>]*aria-label="Send"/);
    expect(typed).not.toContain('data-kind="dictate"');
  });

  test("shows stop while the agent works and nothing is typed, and send again once something is", () => {
    expect(html(box({ onStop: noop }))).toMatch(/data-kind="stop"[^>]*aria-label="Stop"/);
    expect(html(box({ onStop: noop, value: "wait", canSend: true }))).toContain('data-kind="send"');
  });
});

describe("the permission modes in ⌘K", () => {
  const modes: SharedModes = {
    current: "standard",
    list: [
      { id: "strict", label: "Strict", description: "Asks before every tool, reads included" },
      { id: "standard", label: "Standard", description: "Asks before edits and commands; reads run freely" },
      { id: "unrestricted", label: "Unrestricted", description: "Nothing asks — every tool runs" },
    ],
    pick: noop,
  };
  const ids = (list: ReturnType<typeof matchModes>) => list.map((m) => m.id);

  test("the Permissions scope lists every mode, or those whose name or line holds each word typed", () => {
    expect(ids(matchModes(modes, "", true))).toEqual(["strict", "standard", "unrestricted"]);
    expect(ids(matchModes(modes, "edits", true))).toEqual(["standard"]);
    expect(ids(matchModes(modes, "nothing matches", true))).toEqual([]);
  });

  test("plain ⌘K offers none until something is typed, then the modes it names, or all of them for 'permission'", () => {
    expect(matchModes(modes, "", false)).toEqual([]);
    expect(ids(matchModes(modes, "strict", false))).toEqual(["strict"]);
    expect(ids(matchModes(modes, "permission", false))).toEqual(["strict", "standard", "unrestricted"]);
    expect(matchModes(modes, "pe", false)).toEqual([]);
    expect(matchModes(modes, "ferry", false)).toEqual([]);
  });

  test("a chat with no modes to change offers none", () => {
    expect(matchModes(null, "strict", true)).toEqual([]);
  });
});
