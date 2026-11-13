import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { XIcon } from "lucide-react";
import { ThemeProvider } from "../app/src/theme.tsx";
import { GlassIcon, Icon } from "../app/src/shared/icons.tsx";

// Plan 2026-11-12-1505, R8, and the person's choice (2026-11-13): Liquid Glass has one icon set, Lucide, everywhere;
// today's look keeps loki's own drawings and glyphs until U11 retires it. ThemeProvider reads the palette from storage.

const noop = () => {};
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

describe("loki's icons under Liquid Glass", () => {
  test("draw as Lucide's, at its stroke, keeping loki's class and size", () => {
    withPalette("apple");
    const out = html(createElement(Icon, { name: "search", size: 16 }));
    expect(out).toContain("lucide-search");
    expect(out).toContain("loki-icon");
    expect(out).toContain('width="16"');
    expect(out).toContain('stroke-width="1.75"');
  });

  test("a chat is Lucide's speech bubble, and stop stays a filled square", () => {
    withPalette("apple");
    expect(html(createElement(Icon, { name: "desk" }))).toContain("lucide-message-square");
    expect(html(createElement(Icon, { name: "stop" }))).toMatch(/lucide-square[^"]*"[^>]*fill="currentColor"|fill="currentColor"[^>]*lucide-square/);
  });

  test("an icon with a title is still announced as an image by that name", () => {
    withPalette("apple");
    const out = html(createElement(Icon, { name: "info", title: "About" }));
    expect(out).toContain('role="img"');
    expect(out).toContain('aria-label="About"');
    expect(out).toContain("<title>About</title>");
  });

  test("a glyph or drawing of today's look becomes Lucide's icon, hidden from a screen reader", () => {
    withPalette("apple");
    const out = html(createElement(GlassIcon, { icon: XIcon }, "×"));
    expect(out).toContain("lucide-x");
    expect(out).toContain('aria-hidden="true"');
    expect(out).not.toContain("×");
  });
});

describe("today's look", () => {
  test("keeps loki's own drawings and its glyphs", () => {
    withPalette(null);
    expect(html(createElement(Icon, { name: "search" }))).not.toContain("lucide");
    expect(html(createElement(GlassIcon, { icon: XIcon }, "×"))).toBe("×");
  });
});
