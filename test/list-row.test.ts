import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ListRow, ListSection, PaneHeader, countText, rowStatus } from "../app/src/components/index.tsx";

/**
 * The desktop's Slack building blocks (components/index.tsx): a row says its state in words as well as
 * weight and colour, so a screen reader and a colour-blind reader get the same news the red badge gives.
 */

describe("list row words", () => {
  test("counts past two digits read 99+", () => {
    expect([countText(1), countText(99), countText(100)]).toEqual(["1", "99", "99+"]);
  });
  test("the status says unread, the waiting count and live in words; nothing when quiet", () => {
    expect(rowStatus({ unread: true, badge: 3, live: true })).toBe("unread, 3 waiting, working");
    expect(rowStatus({ badge: 1, badgeNoun: "needs you" })).toBe("1 needs you");
    expect(rowStatus({ badge: 0 })).toBe("");
    expect(rowStatus({})).toBe("");
  });
});

describe("list row markup", () => {
  const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
  test("an unread row draws a bold title and a badge whose words do not rely on colour", () => {
    const out = html(createElement(ListRow, { title: "Loki mobile", unread: true, badge: 3, onOpen: () => {} }));
    expect(out).toContain("loki-list-row--unread");
    expect(out).toMatch(/class="loki-list-badge" aria-hidden="true">3</);
    expect(out).toContain(">unread, 3 waiting</span>");
  });
  test("a quiet row shows its time and no badge; the current one is marked for assistive tech", () => {
    const out = html(createElement(ListRow, { title: "Budget", time: "3h", current: true, onOpen: () => {} }));
    expect(out).not.toContain("loki-list-badge");
    expect(out).not.toContain("loki-list-row--unread");
    expect(out).toContain('aria-current="page"');
    expect(out).toContain(">3h<");
  });
  test("a folded section says so and draws no list", () => {
    const out = html(createElement(ListSection, { title: "Friday", open: false, onToggle: () => {}, children: createElement(ListRow, { title: "x", onOpen: () => {} }) }));
    expect(out).toContain('aria-expanded="false"');
    expect(out).not.toContain("loki-list-row");
  });
  test("the pane header's tab row is a tablist with one selected tab, reachable by Tab", () => {
    const out = html(createElement(PaneHeader, { title: "Loki mobile", tabs: [{ id: "messages", label: "Messages" }, { id: "desk", label: "Desk" }], tab: "desk", onTab: () => {}, tabsLabel: "Desk views" }));
    expect(out).toContain('role="tablist"');
    expect(out).toContain('aria-label="Desk views"');
    expect(out.match(/aria-selected="true"/g)?.length).toBe(1);
    expect(out).toMatch(/aria-selected="true" tabindex="0"[^>]*>(<[^>]+>)*Desk/);
    expect(out).toMatch(/aria-selected="false" tabindex="-1"/);
  });
});
