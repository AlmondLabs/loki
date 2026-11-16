import { describe, expect, test, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "../app/src/theme.tsx";
import { KeysSheet } from "../app/src/shell/keys-sheet.tsx";

// A desktop sheet is Base UI's portalled Dialog, which a static render does not draw; here it draws in place.
vi.mock("../app/src/ui/dialog.tsx", () => import("./fixtures/inline-dialog.ts"));

const noop = () => {};
const html = (el: ReactElement) => renderToStaticMarkup(createElement(ThemeProvider, null, el));
const sheet = () => createElement(KeysSheet, { segment: "desk", onClose: noop, onSettings: noop });

describe("the keys sheet", () => {
  test("dims nothing behind it, and names the view as the sidebar does", () => {
    const out = html(sheet());
    expect(out).toContain("loki-sheet-veil--clear");
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
