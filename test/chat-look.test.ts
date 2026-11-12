import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PendingApproval } from "../core/attention/model.ts";
import { ThemeProvider } from "../app/src/theme.tsx";
import { ActionBar } from "../app/src/item/action-bar.tsx";
import { ApprovalProposal } from "../app/src/item/proposal.tsx";

// Plan 2026-11-12-1505, U4: the chat pane on Liquid Glass. ThemeProvider reads the palette from storage, so these put
// the apple family there for the glass cases and leave it empty for today's look.

const noop = () => {};
const approval: PendingApproval = { requestId: "r1", toolName: "Edit notes.txt", input: { path: "notes.txt" }, at: "2026-11-12T09:00:00Z" };
const verbs = { archive: { run: noop, keys: "⌘E" }, later: { run: noop }, mark_read: { run: noop } };

let saved: Storage | undefined;
const withPalette = (palette: string | null) => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => (key === "loki.palette" ? palette : null), setItem: noop },
  });
};
const html = (el: ReactElement) => renderToStaticMarkup(createElement(ThemeProvider, null, el));

beforeEach(() => {
  saved = globalThis.localStorage;
});
afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: saved });
});

describe("the approval under Liquid Glass", () => {
  test("asks a question naming the agent and the step, with Deny, Always Allow and Allow in that order", () => {
    withPalette("apple");
    const out = html(createElement(ApprovalProposal, { approval, onApprove: noop, who: "friday" }));
    expect(out).toContain("Allow friday to run “Edit notes.txt”?");
    expect([...out.matchAll(/data-action="(\w+)"/g)].map((m) => m[1])).toEqual(["deny", "always", "approve"]);
    expect(out).toContain(">Allow</button>");
    expect(out).toContain("&quot;path&quot;: &quot;notes.txt&quot;");
  });

  test("keeps today's card in today's look", () => {
    withPalette(null);
    const out = html(createElement(ApprovalProposal, { approval, onApprove: noop, who: "friday" }));
    expect(out).toContain("awaiting approval");
    expect(out).not.toContain("Allow friday");
  });
});

describe("the moves under the box under Liquid Glass", () => {
  test("take Apple's words, and the key moves from the face into the tooltip", () => {
    withPalette("apple");
    const out = html(createElement(ActionBar, { view: { main: "archive", more: ["later", "mark_read"] }, verbs }));
    expect(out).toContain(">Mark as Read</button>");
    expect(out).toMatch(/title="Archive \(⌘E\)"[^>]*>Archive<\/button>/);
    expect(out).not.toContain("<kbd");
  });

  test("today's look keeps the lowercase word with its key beside it", () => {
    withPalette(null);
    const out = html(createElement(ActionBar, { view: { main: "archive", more: ["later", "mark_read"] }, verbs }));
    expect(out).toContain(">read</button>");
    expect(out).toContain("<kbd");
  });
});

describe("the thread under the floating header and dock", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "app", "src", "components", "components.css"), "utf8");
  test("pads itself by the measured heights, and the dock has no box outside Liquid Glass", () => {
    expect(css).toMatch(/\.loki-dock \{\s*display: contents;\s*\}/);
    expect(css).toMatch(/padding-top: calc\(var\(--loki-header-height\) \+ 20px\);/);
    expect(css).toMatch(/padding-bottom: calc\(var\(--loki-dock-height\) \+ 20px\);/);
  });
});
