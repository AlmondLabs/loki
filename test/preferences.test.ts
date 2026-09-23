import { describe, expect, test } from "bun:test";
import { afterSegmentKey } from "../app/src/settings/preferences.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PAGES, pageAfterKey, pageTitle } from "../app/src/settings/pages.ts";
import { PageList } from "../app/src/settings/PageList.tsx";

describe("Preferences: the segment keys over the sheet", () => {
  test("⌘, (and ⌘6, the same binding) opens Preferences over any section and closes it when open; the section stays", () => {
    for (const s of ["desk", "inbox", "board", "agents", "learn"] as const) {
      expect(afterSegmentKey("segment.settings", { segment: s, preferences: false })).toEqual({ segment: s, preferences: true });
      expect(afterSegmentKey("segment.settings", { segment: s, preferences: true })).toEqual({ segment: s, preferences: false });
    }
  });
  test("⌘2 while Preferences is open closes it and shows the Inbox; ⌘1-5 likewise go to their section", () => {
    expect(afterSegmentKey("segment.inbox", { segment: "board", preferences: true })).toEqual({ segment: "inbox", preferences: false });
    expect(afterSegmentKey("segment.desk", { segment: "learn", preferences: true })).toEqual({ segment: "desk", preferences: false });
    expect(afterSegmentKey("segment.agents", { segment: "agents", preferences: false })).toEqual({ segment: "agents", preferences: false });
  });
  test("an old window that saved settings as its segment reopens on the desk", () => {
    expect(afterSegmentKey("segment.desk", { segment: "settings", preferences: false })).toEqual({ segment: "desk", preferences: false });
    expect(afterSegmentKey("segment.settings", { segment: "settings", preferences: false })).toEqual({ segment: "desk", preferences: true });
  });
});

describe("Preferences: the section list", () => {
  test("every page has a sentence-case name, loki's proper nouns kept", () => {
    expect(PAGES.map((p) => pageTitle(p.id))).toEqual(["Letta", "Inbox", "Providers", "Phone", "Skills", "Learn", "Appearance", "Chat", "Files", "Keys"]);
    for (const p of PAGES) expect(pageTitle(p.id)[0]).toBe(pageTitle(p.id)[0].toUpperCase());
  });
});

describe("Preferences: the section list is a vertical tablist (focus follows the chosen page)", () => {
  test("↑↓ step the pages and wrap, Home and End jump; other keys are not the list's", () => {
    expect(pageAfterKey("letta", "ArrowDown")).toBe("inbox");
    expect(pageAfterKey("inbox", "ArrowUp")).toBe("letta");
    expect(pageAfterKey("letta", "ArrowUp")).toBe("keys");
    expect(pageAfterKey("keys", "ArrowDown")).toBe("letta");
    expect(pageAfterKey("chat", "Home")).toBe("letta");
    expect(pageAfterKey("chat", "End")).toBe("keys");
    expect(pageAfterKey("chat", "ArrowRight")).toBeNull();
    expect(pageAfterKey("chat", "Enter")).toBeNull();
  });
  test("the chosen page is the one Tab stop and says it is selected; the rest are reached by arrows", () => {
    const out = renderToStaticMarkup(createElement(PageList, { page: "skills", onPick: () => {} }));
    expect(out).toContain('role="tablist"');
    expect(out).toContain('aria-orientation="vertical"');
    const tabs = [...out.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    expect(tabs).toHaveLength(PAGES.length);
    const chosen = tabs.filter((t) => t.includes('aria-selected="true"'));
    expect(chosen).toHaveLength(1);
    expect(chosen[0]).toContain('data-page="skills"');
    expect(chosen[0]).toContain('tabindex="0"');
    expect(tabs.filter((t) => t.includes('tabindex="-1"'))).toHaveLength(PAGES.length - 1);
    for (const t of tabs) expect(t).toContain('role="tab"');
  });
});
