import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Popover } from "../app/src/components/index.tsx";

const trigger = createElement("button", { type: "button" as const }, "Links");
const props = { trigger, onOpenChange: () => {}, role: "dialog" as const, "aria-label": "Links to other chats" };

describe("a popover and its control", () => {
  test("closed on the desktop, the control says what it opens and that it is shut, and no panel is drawn", () => {
    const out = renderToStaticMarkup(createElement(Popover, { ...props, open: false }, "the list"));
    expect(out).toContain('aria-haspopup="dialog"');
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain(">Links</button>");
    expect(out).not.toContain("the list");
  });

  test("a menu's control says it opens a menu", () => {
    const out = renderToStaticMarkup(createElement(Popover, { ...props, role: "menu", "aria-label": "Chat actions", open: false }, "rows"));
    expect(out).toContain('aria-haspopup="menu"');
  });

  test("open on the phone, its own panel sits beside the control with its role and name", () => {
    const out = renderToStaticMarkup(createElement(Popover, { ...props, open: true, touch: true, side: "above" }, "the list"));
    expect(out).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*aria-expanded="true"[^>]*>Links<\/button><div[^>]*role="dialog"/);
    expect(out).toContain('aria-label="Links to other chats"');
    expect(out).toContain('class="loki-popover loki-popover--above"');
    expect(out).toContain("the list");
  });
});
