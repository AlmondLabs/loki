import { describe, expect, test } from "vitest";
import { afterSegmentKey } from "../app/src/settings/preferences.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GROUPS, PAGES, groupOf, pageAfterKey, pageTitle, pagesMatching, savedPage } from "../app/src/settings/pages.ts";
import { PageList } from "../app/src/settings/page-list.tsx";
import { Phone, type PhoneApi } from "../app/src/settings/phone.tsx";
import { GlobalKeyRow } from "../app/src/settings/settings.tsx";
import { lanStatusFromFrame } from "../app/src/phone/model.ts";
import { shortcutAvailable, type GlobalShortcut } from "../app/src/shell/use-global-shortcut.ts";
import { dictateTitle, dictationSupported } from "../app/src/chat/use-dictation.ts";
import { notYetOn } from "../app/src/desk/env.ts";

describe("Preferences: the segment keys over the sheet", () => {
  test("⌘, (and ⌘6, the same binding) opens Preferences over any section and closes it when open; the section stays", () => {
    for (const s of ["desk", "inbox", "tasks", "agents", "learn"] as const) {
      expect(afterSegmentKey("segment.settings", { segment: s, preferences: false })).toEqual({ segment: s, preferences: true });
      expect(afterSegmentKey("segment.settings", { segment: s, preferences: true })).toEqual({ segment: s, preferences: false });
    }
  });
  test("⌘2 while Preferences is open closes it and shows the Inbox; ⌘1-5 likewise go to their section", () => {
    expect(afterSegmentKey("segment.inbox", { segment: "tasks", preferences: true })).toEqual({ segment: "inbox", preferences: false });
    expect(afterSegmentKey("segment.desk", { segment: "learn", preferences: true })).toEqual({ segment: "desk", preferences: false });
    expect(afterSegmentKey("segment.agents", { segment: "agents", preferences: false })).toEqual({ segment: "agents", preferences: false });
  });
  test("an old window that saved settings as its segment reopens on the desk", () => {
    expect(afterSegmentKey("segment.desk", { segment: "settings", preferences: false })).toEqual({ segment: "desk", preferences: false });
    expect(afterSegmentKey("segment.settings", { segment: "settings", preferences: false })).toEqual({ segment: "desk", preferences: true });
  });
});

describe("Preferences: the section list", () => {
  test("the groups hold every page once, and the list is the groups' pages in order", () => {
    expect(GROUPS.map((g) => g.title)).toEqual(["General", "Models and tools", "Your devices", "Inbox and Learn", "Labels", "loki"]);
    expect(PAGES.map((p) => pageTitle(p.id))).toEqual([
      "Appearance",
      "Chat",
      "Keyboard shortcuts",
      "Providers",
      "Engines",
      "MCP servers",
      "Skills",
      "Macs",
      "Phone",
      "Inbox",
      "Learn",
      "Labels",
      "About",
      "Usage",
    ]);
    expect(new Set(PAGES.map((p) => p.id)).size).toBe(PAGES.length);
    for (const p of PAGES) expect(pageTitle(p.id)[0]).toBe(pageTitle(p.id)[0].toUpperCase());
  });

  test("a saved page opens as it was; the old Files page id opens About; none opens the first page", () => {
    expect(savedPage("skills")).toBe("skills");
    expect(savedPage("files")).toBe("loki");
    expect(savedPage(null)).toBe("appearance");
    expect(savedPage("harness")).toBe("appearance");
  });

  test("the filter keeps pages by name, group or word, case aside; empty keeps them all", () => {
    expect(pagesMatching("")).toEqual(PAGES.map((p) => p.id));
    expect(pagesMatching("  ")).toEqual(PAGES.map((p) => p.id));
    expect(pagesMatching("pair")).toEqual(["macs", "phone"]);
    expect(pagesMatching("DEVICES")).toEqual(["macs", "phone"]);
    expect(pagesMatching("dark")).toEqual(["appearance"]);
    expect(pagesMatching("shortcuts")).toEqual(["keys"]);
    expect(pagesMatching("zzz")).toEqual([]);
  });
});

describe("Preferences: the section list is a vertical tablist (focus follows the chosen page)", () => {
  test("↑↓ step the groups and wrap, landing on a group's first page; Home and End jump; other keys are not the list's", () => {
    expect(pageAfterKey("appearance", "ArrowDown")).toBe("providers");
    expect(pageAfterKey("keys", "ArrowDown")).toBe("providers");
    expect(pageAfterKey("mcp", "ArrowUp")).toBe("appearance");
    expect(pageAfterKey("appearance", "ArrowUp")).toBe("loki");
    expect(pageAfterKey("usage", "ArrowDown")).toBe("appearance");
    expect(pageAfterKey("chat", "Home")).toBe("appearance");
    expect(pageAfterKey("chat", "End")).toBe("loki");
    expect(pageAfterKey("chat", "ArrowRight")).toBeNull();
    expect(pageAfterKey("chat", "Enter")).toBeNull();
  });
  test("with a filter the keys walk the groups it left, from a page it hid too, landing on the pages it kept", () => {
    const left = pagesMatching("pair");
    expect(pageAfterKey("macs", "ArrowDown", left)).toBe("macs");
    expect(pageAfterKey("skills", "ArrowDown", left)).toBe("macs");
    const tools = pagesMatching("tools");
    expect(tools).toEqual(["providers", "engines", "mcp", "skills"]);
    expect(pageAfterKey("appearance", "ArrowDown", pagesMatching("dark"))).toBe("appearance");
    expect(pageAfterKey("skills", "ArrowDown", [])).toBeNull();
  });
  test("each page is a tab of one group", () => {
    for (const p of PAGES) expect(groupOf(p.id).pages).toContain(p.id);
    expect(groupOf("usage").title).toBe("loki");
  });
  test("the chosen group is the one Tab stop and says it is selected; the rest are reached by arrows", () => {
    const out = renderToStaticMarkup(createElement(PageList, { page: "skills", onPick: () => {} }));
    expect(out).toContain('role="tablist"');
    expect(out).toContain('aria-orientation="vertical"');
    const tabs = [...out.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((m) => m[0]);
    expect(tabs).toHaveLength(GROUPS.length);
    const chosen = tabs.filter((t) => t.includes('aria-selected="true"'));
    expect(chosen).toHaveLength(1);
    expect(chosen[0]).toContain('data-group="Models and tools"');
    expect(chosen[0]).toContain('tabindex="0"');
    expect(tabs.filter((t) => t.includes('tabindex="-1"'))).toHaveLength(GROUPS.length - 1);
  });
});

describe("Mac extras only on the Mac (plan 014 U3, R3)", () => {
  const text = (html: string) =>
    html
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&");
  const status = { ...lanStatusFromFrame({ enabled: true, address: "192.168.1.20", appServed: true }), via: "lan" as const };
  const phone: PhoneApi = {
    status,
    devices: [],
    lastCode: { code: "K7PQ2M", url: "http://192.168.1.20:41415/pair?c=K7PQ2M", expiresAt: new Date(Date.now() + 600_000).toISOString() },
    refresh: () => {},
    setEnabled: () => {},
    setVia: () => {},
    setServe: () => {},
    beginPair: () => {},
    forget: () => {},
  };
  const shortcut: GlobalShortcut = { available: true, enabled: true, error: null, set: () => {} };

  test("AE4: Preferences › phone on Linux says pairing is not on Linux yet, with no pairing code, switch or route", () => {
    const out = text(renderToStaticMarkup(createElement(Phone, { phone, connected: true, os: "linux" })));
    expect(out).toContain("Phone pairing isn't on Linux yet");
    expect(out).not.toContain("K7PQ2M");
    expect(out).not.toContain('role="switch"');
    expect(out).not.toContain("Tailscale");
    expect(out).not.toContain("asking the mod");
    expect(text(renderToStaticMarkup(createElement(Phone, { phone, connected: false, os: "windows" })))).toContain("Phone pairing isn't on Windows yet");
  });
  test("the Mac's phone page is as it was: the switch, the route and the code", () => {
    const out = text(renderToStaticMarkup(createElement(Phone, { phone, connected: true, os: "macos" })));
    expect(out).toContain('role="switch"');
    expect(out).toContain("Phones can reach this Mac");
    expect(out).toContain("K7PQ2M");
    expect(out).not.toContain("isn't on");
    expect(renderToStaticMarkup(createElement(Phone, { phone, connected: true }))).toBe(
      renderToStaticMarkup(createElement(Phone, { phone, connected: true, os: "macos" })),
    );
  });
  test("the global-shortcut row on Windows says it is not there yet, with no switch and no Mac key", () => {
    const out = text(renderToStaticMarkup(createElement(GlobalKeyRow, { shortcut, os: "windows" })));
    expect(out).toContain("isn't on Windows yet");
    expect(out).not.toContain('role="switch"');
    expect(out).not.toContain("⌥");
    expect(text(renderToStaticMarkup(createElement(GlobalKeyRow, { shortcut, os: "linux" })))).toContain("isn't on Linux yet");
  });
  test("on the Mac the global-shortcut row is ⌥Space with its switch, or the browser-tab line", () => {
    const out = text(renderToStaticMarkup(createElement(GlobalKeyRow, { shortcut, os: "macos" })));
    expect(out).toContain("⌥Space");
    expect(out).toContain('role="switch"');
    const tab = text(renderToStaticMarkup(createElement(GlobalKeyRow, { shortcut: { ...shortcut, available: false }, os: "macos" })));
    expect(tab).toContain("a browser tab cannot hold a system-wide key");
    expect(tab).not.toContain('role="switch"');
  });
  test("the shell holds the global shortcut on the Mac only; a browser tab never", () => {
    expect(shortcutAvailable(true, "macos")).toBe(true);
    expect(shortcutAvailable(true, "windows")).toBe(false);
    expect(shortcutAvailable(true, "linux")).toBe(false);
    expect(shortcutAvailable(false, "macos")).toBe(false);
  });
  test("the mic is in the message box on the Mac when speech recognition exists, never on Windows or Linux", () => {
    expect(dictationSupported(true, "macos", false)).toBe(true);
    expect(dictationSupported(false, "macos", false)).toBe(false);
    expect(dictationSupported(true, "windows", false)).toBe(false);
    expect(dictationSupported(true, "linux", false)).toBe(false);
  });
  test("a phone keeps its mic whatever its user agent reads as (an Android phone reads as linux)", () => {
    expect(dictationSupported(true, "linux", true)).toBe(true);
    expect(dictationSupported(false, "linux", true)).toBe(false);
  });
  test("the mic's tooltip names its key where the key is listed; a phone reading as Linux gets the mic without one", () => {
    expect(dictateTitle("macos")).toBe("dictate (⌘D)");
    expect(dictateTitle("linux")).toBe("dictate");
    expect(dictateTitle("windows")).toBe("dictate");
  });
  test("the not-yet line names the system", () => {
    expect(notYetOn("Phone pairing", "windows")).toBe("Phone pairing isn't on Windows yet");
    expect(notYetOn("Phone pairing", "linux")).toBe("Phone pairing isn't on Linux yet");
  });
});
