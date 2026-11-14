import { describe, expect, test } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { XIcon } from "lucide-react";
import { ThemeProvider } from "../app/src/theme.tsx";
import { Glyph, Icon } from "../app/src/shared/icons.tsx";

// Plan 2026-11-12-1505, R8, and the person's choice (2026-11-13): loki has one icon set, Lucide, everywhere. U11 retired
// loki's own drawings along with today's look.

const html = (el: ReactElement) => renderToStaticMarkup(createElement(ThemeProvider, null, el));

describe("loki's icons", () => {
  test("draw as Lucide's, at its stroke, keeping loki's class and size", () => {
    const out = html(createElement(Icon, { name: "search", size: 16 }));
    expect(out).toContain("lucide-search");
    expect(out).toContain("loki-icon");
    expect(out).toContain('width="16"');
    expect(out).toContain('stroke-width="1.75"');
  });

  test("a chat is Lucide's speech bubble, and stop stays a filled square", () => {
    expect(html(createElement(Icon, { name: "desk" }))).toContain("lucide-message-square");
    expect(html(createElement(Icon, { name: "stop" }))).toMatch(/lucide-square[^"]*"[^>]*fill="currentColor"|fill="currentColor"[^>]*lucide-square/);
  });

  test("an icon with a title is still announced as an image by that name", () => {
    const out = html(createElement(Icon, { name: "info", title: "About" }));
    expect(out).toContain('role="img"');
    expect(out).toContain('aria-label="About"');
    expect(out).toContain("<title>About</title>");
  });

  test("a glyph is Lucide's icon at loki's stroke, hidden from a screen reader", () => {
    const out = html(createElement(Glyph, { icon: XIcon }));
    expect(out).toContain("lucide-x");
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain('stroke-width="1.75"');
  });
});
