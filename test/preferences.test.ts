import { describe, expect, test } from "bun:test";
import { afterSegmentKey } from "../app/src/settings/preferences.ts";
import { PAGES, pageTitle } from "../app/src/settings/pages.ts";

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
