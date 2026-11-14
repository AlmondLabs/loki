import { describe, expect, test } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "../app/src/theme.tsx";
import { KeysSheet } from "../app/src/shell/keys-sheet.tsx";

// Plan 2026-11-12-1505, U20: the keys sheet is a plain panel that dims nothing; U11 made it the only one.

const noop = () => {};
const html = (el: ReactElement) => renderToStaticMarkup(createElement(ThemeProvider, null, el));
const sheet = () => createElement(KeysSheet, { segment: "desk", onClose: noop, onSettings: noop });

describe("the keys sheet", () => {
  test("dims nothing behind it, and names the view as the sidebar does", () => {
    const out = html(sheet());
    expect(out).toContain("loki-veil--clear");
    expect(out).toContain('aria-label="Keys for Chats"');
    expect(out).toContain(">Chats</span>");
  });

  test("starts every row with a capital, and puts no key or closing hint on its faces", () => {
    const out = html(sheet());
    expect(out).toContain("Back to Messages from the Canvas tab");
    expect(out).toContain("Not while typing");
    expect(out).not.toContain("? or esc closes");
    expect(out).toMatch(/<button[^>]*title="Open Keys \([^)]+\)"[^>]*>Open<\/button>/);
  });

  test("lets a long list scroll inside the panel", () => {
    expect(html(sheet())).toContain("overflow-y:auto");
  });
});
