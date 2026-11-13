import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "../app/src/theme.tsx";
import { KeysSheet } from "../app/src/shell/keys-sheet.tsx";

// Plan 2026-11-12-1505, U20: under Liquid Glass the keys sheet is a plain panel that dims nothing. ThemeProvider reads
// the palette from storage, so the apple family is put there for the glass cases and left out for today's look.

const noop = () => {};
let saved: Storage | undefined;
const withPalette = (palette: string | null) => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => (key === "loki.palette" ? palette : null), setItem: noop },
  });
};
const html = (el: ReactElement) => renderToStaticMarkup(createElement(ThemeProvider, null, el));
const sheet = () => createElement(KeysSheet, { segment: "desk", onClose: noop, onSettings: noop });

beforeEach(() => {
  saved = globalThis.localStorage;
});
afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: saved });
});

describe("the keys sheet under Liquid Glass", () => {
  test("dims nothing behind it, and names the view as the sidebar does", () => {
    withPalette("apple");
    const out = html(sheet());
    expect(out).toContain("loki-veil--clear");
    expect(out).toContain('aria-label="Keys for Chats"');
    expect(out).toContain(">Chats</span>");
  });

  test("starts every row with a capital, and puts no key or closing hint on its faces", () => {
    withPalette("apple");
    const out = html(sheet());
    expect(out).toContain("Back to Messages from the Canvas tab");
    expect(out).toContain("Not while typing");
    expect(out).not.toContain("? or esc closes");
    expect(out).toMatch(/<button[^>]*title="Open Keys \([^)]+\)"[^>]*>Open<\/button>/);
  });

  test("lets a long list scroll inside the panel in either look", () => {
    for (const palette of ["apple", null]) {
      withPalette(palette);
      expect(html(sheet())).toContain("overflow-y:auto");
    }
  });

  test("keeps today's sheet in today's look: dimmed, the view by its id, the hint and the key on the button", () => {
    withPalette(null);
    const out = html(sheet());
    expect(out).not.toContain("loki-veil--clear");
    expect(out).toContain("? or esc closes");
    expect(out).toContain("back to Messages from the Canvas tab");
    expect(out).toContain(">open");
  });
});
