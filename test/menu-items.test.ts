import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DrawnMenu } from "../app/src/shell/menu-items.tsx";
import type { MenuEntry } from "../app/src/shell/native-menu.ts";

const entries: MenuEntry[] = [{ type: "item", id: "a", label: "Arrange Widgets", run: () => {} }];
const trigger = createElement("button", { type: "button" as const }, "More");

describe("a drawn menu", () => {
  test("closed, its button says it opens a menu and that it is shut, and no menu is drawn", () => {
    const out = renderToStaticMarkup(createElement(DrawnMenu, { label: "Chat actions", entries, open: false, onOpenChange: () => {}, trigger }));
    expect(out).toMatch(/<button[^>]*aria-haspopup="menu"/);
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain(">More</button>");
    expect(out).not.toContain("Arrange Widgets");
  });

  test("hung from a point, it draws no button of its own", () => {
    const out = renderToStaticMarkup(createElement(DrawnMenu, { label: "Chat actions", entries, open: false, onOpenChange: () => {}, at: { x: 10, y: 20 } }));
    expect(out).not.toContain("<button");
  });
});
