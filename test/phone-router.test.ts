import { describe, expect, test } from "bun:test";
import { HOME, TABS, backTarget, depthOf, entryState, formatRoute, isOverlay, labelOf, originOf, ownerOf, parentOf, parseRoute, showsNav, type Route } from "../app/src/phone/router.ts";

/**
 * The phone's hash routes (app/src/phone/router.ts): every route both ways, file paths with slashes
 * and encoded slashes, conversation ids the app-server mints locally, and the fallback to home.
 */

const roundTrip = (r: Route) => expect(parseRoute(formatRoute(r))).toEqual(r);

describe("tabs", () => {
  test("each tab formats and parses", () => {
    expect(TABS).toEqual(["home", "inbox", "agents", "more"]);
    for (const tab of ["home", "inbox", "agents", "more"] as const) {
      expect(formatRoute({ kind: "tab", tab })).toBe(`#/${tab}`);
      roundTrip({ kind: "tab", tab });
    }
  });
  test("legacy You and Settings links land on More and preferences", () => {
    expect(parseRoute("#/you")).toEqual({ kind: "tab", tab: "more" });
    expect(parseRoute("#/settings")).toEqual({ kind: "preferences" });
    // and they format to the canonical address, so the shell can swap the legacy one out
    expect(formatRoute(parseRoute("#/you"))).toBe("#/more");
    expect(formatRoute(parseRoute("#/settings"))).toBe("#/preferences");
  });
  test("an empty or unknown hash is home", () => {
    expect(parseRoute("")).toEqual(HOME);
    expect(parseRoute("#")).toEqual(HOME);
    expect(parseRoute("#/")).toEqual(HOME);
    expect(parseRoute("#/nowhere")).toEqual(HOME);
    expect(parseRoute("#/home/extra")).toEqual(HOME);
    expect(parseRoute("#/c/only-agent")).toEqual(HOME); // a conversation needs both ids
  });
  test("the leading # is optional", () => {
    expect(parseRoute("/inbox")).toEqual({ kind: "tab", tab: "inbox" });
  });
});

describe("agents", () => {
  test("an agent page", () => {
    expect(formatRoute({ kind: "agent", agentId: "agent-abc123" })).toBe("#/agents/agent-abc123");
    roundTrip({ kind: "agent", agentId: "agent-abc123" });
  });
  test("a file: path segments stay readable, each encoded", () => {
    const r: Route = { kind: "file", agentId: "agent-abc123", path: "system/persona.md" };
    expect(formatRoute(r)).toBe("#/agents/agent-abc123/file/system/persona.md");
    roundTrip(r);
  });
  test("deeper paths and spaces", () => {
    const r: Route = { kind: "file", agentId: "a1", path: "reference/notes/my notes.md" };
    expect(formatRoute(r)).toBe("#/agents/a1/file/reference/notes/my%20notes.md");
    roundTrip(r);
  });
  test("a %2F in the address is a slash in the path", () => {
    expect(parseRoute("#/agents/a1/file/system%2Fpersona.md")).toEqual({ kind: "file", agentId: "a1", path: "system/persona.md" });
    expect(parseRoute("#/agents/a1/file/reference%2Fdeep%2Fnote.md")).toEqual({ kind: "file", agentId: "a1", path: "reference/deep/note.md" });
  });
  test("a skill's SKILL.md", () => {
    roundTrip({ kind: "file", agentId: "a1", path: "skills/loki/SKILL.md" });
  });
  test("/file with no path is the agent page; an unknown sub-page too", () => {
    expect(parseRoute("#/agents/a1/file")).toEqual({ kind: "agent", agentId: "a1" });
    expect(parseRoute("#/agents/a1/other")).toEqual({ kind: "agent", agentId: "a1" });
  });
  test("a bad percent sequence does not throw", () => {
    expect(parseRoute("#/agents/a1/file/%E0%A4%A")).toEqual({ kind: "file", agentId: "a1", path: "%E0%A4%A" });
  });
});

describe("conversations", () => {
  test("agent and conversation ids", () => {
    const r: Route = { kind: "conversation", agentId: "agent-9f2c", conversationId: "local-conv-1725700000000-x7k2", prefill: null };
    expect(formatRoute(r)).toBe("#/c/agent-9f2c/local-conv-1725700000000-x7k2");
    roundTrip(r);
  });
  test("the main chat is `default`", () => {
    roundTrip({ kind: "conversation", agentId: "agent-9f2c", conversationId: "default", prefill: null });
  });
  test("a prefill rides in the query and comes back verbatim", () => {
    const r: Route = { kind: "conversation", agentId: "a1", conversationId: "default", prefill: "Please update system/persona.md: " };
    expect(formatRoute(r)).toBe("#/c/a1/default?prefill=Please%20update%20system%2Fpersona.md%3A%20");
    roundTrip(r);
  });
  test("an empty prefill is none", () => {
    expect(parseRoute("#/c/a1/default?prefill=")).toEqual({ kind: "conversation", agentId: "a1", conversationId: "default", prefill: null });
  });
});

describe("child routes", () => {
  test("search, archive and preferences have stable direct links", () => {
    for (const [kind, hash] of [["search", "#/search"], ["archive", "#/archive"], ["preferences", "#/preferences"], ["learn", "#/learn"]] as const) {
      const r = { kind } as Route;
      expect(formatRoute(r)).toBe(hash);
      roundTrip(r);
    }
  });
  test("More's connection and About pages have stable direct links, owned by More", () => {
    for (const kind of ["connection", "about"] as const) {
      const r = { kind } as Route;
      expect(formatRoute(r)).toBe(`#/${kind}`);
      roundTrip(r);
      expect(ownerOf(r)).toBe("more");
      expect(parentOf(r)).toEqual({ kind: "tab", tab: "more" });
      expect(showsNav(r)).toBe(false);
      expect(labelOf(r)).toBe(kind);
    }
  });
  test("a child with extra segments is not a child", () => {
    expect(parseRoute("#/search/x")).toEqual(HOME);
    expect(parseRoute("#/preferences/x")).toEqual(HOME);
  });
});

describe("ownership and Back", () => {
  const conv: Route = { kind: "conversation", agentId: "a", conversationId: "c", prefill: null };
  const file: Route = { kind: "file", agentId: "a", path: "x.md" };
  test("every route has an owning tab", () => {
    for (const tab of TABS) expect(ownerOf({ kind: "tab", tab })).toBe(tab);
    expect(ownerOf({ kind: "learn" })).toBe("home");
    expect(ownerOf({ kind: "archive" })).toBe("home");
    expect(ownerOf({ kind: "search" })).toBe("home");
    expect(ownerOf({ kind: "preferences" })).toBe("more");
    expect(ownerOf({ kind: "agent", agentId: "a" })).toBe("agents");
    expect(ownerOf(file)).toBe("agents");
    expect(ownerOf(conv)).toBe("home");
  });
  test("direct links fall back deterministically: a file to its agent, the rest to their owner", () => {
    expect(parentOf({ kind: "search" })).toEqual({ kind: "tab", tab: "home" });
    expect(parentOf({ kind: "archive" })).toEqual({ kind: "tab", tab: "home" });
    expect(parentOf({ kind: "learn" })).toEqual({ kind: "tab", tab: "home" });
    expect(parentOf({ kind: "preferences" })).toEqual({ kind: "tab", tab: "more" });
    expect(parentOf({ kind: "agent", agentId: "a" })).toEqual({ kind: "tab", tab: "agents" });
    expect(parentOf(file)).toEqual({ kind: "agent", agentId: "a" });
    expect(parentOf(conv)).toEqual({ kind: "tab", tab: "home" });
    expect(parentOf({ kind: "tab", tab: "inbox" })).toEqual({ kind: "tab", tab: "inbox" });
  });
  test("Back goes to the launching destination when there is one", () => {
    const inbox: Route = { kind: "tab", tab: "inbox" };
    expect(backTarget(conv, inbox)).toEqual(inbox);
    expect(backTarget(conv, null)).toEqual({ kind: "tab", tab: "home" });
    expect(backTarget({ kind: "archive" }, { kind: "tab", tab: "more" })).toEqual({ kind: "tab", tab: "more" });
    // an origin equal to the page itself (a reload of a typed address) is no origin
    expect(backTarget(conv, conv)).toEqual({ kind: "tab", tab: "home" });
  });
  test("the origin rides in the history entry and survives foreign state", () => {
    const s = entryState({ other: 1 }, "#/inbox");
    expect(s).toMatchObject({ other: 1, lokiFrom: "#/inbox", lokiDepth: 1 });
    expect(originOf(s)).toEqual({ kind: "tab", tab: "inbox" });
    expect(depthOf(s)).toBe(1);
    expect(depthOf(entryState(s, "#/c/a/c"))).toBe(2);
    for (const junk of [null, undefined, 3, "x", {}, { lokiFrom: 4, lokiDepth: "2" }]) {
      expect(originOf(junk)).toBeNull();
      expect(depthOf(junk)).toBe(0);
    }
  });
  test("labels for Back read as destinations", () => {
    expect(labelOf({ kind: "tab", tab: "inbox" })).toBe("inbox");
    expect(labelOf({ kind: "tab", tab: "more" })).toBe("more");
    expect(labelOf({ kind: "search" })).toBe("search");
    expect(labelOf({ kind: "archive" })).toBe("archive");
    expect(labelOf({ kind: "preferences" })).toBe("preferences");
  });
});

describe("navigation / overlay", () => {
  test("only tabs show the navigation", () => {
    for (const tab of TABS) expect(showsNav({ kind: "tab", tab })).toBe(true);
    for (const kind of ["learn", "search", "archive", "preferences"] as const) expect(showsNav({ kind } as Route)).toBe(false);
    expect(isOverlay(HOME)).toBe(false);
    expect(isOverlay({ kind: "learn" })).toBe(true);
    expect(isOverlay({ kind: "agent", agentId: "a" })).toBe(true);
    expect(isOverlay({ kind: "conversation", agentId: "a", conversationId: "c", prefill: null })).toBe(true);
  });
});

describe("learn", () => {
  test("is a full-screen Home child with a stable direct link", () => {
    const route: Route = { kind: "learn" };
    expect(formatRoute(route)).toBe("#/learn");
    roundTrip(route);
  });
});

describe("navigation labels", () => {
  test("names, counts and the 99+ cap read the same to eyes and screen readers", async () => {
    const { badgeText, navLabel, TAB_LABEL } = await import("../app/src/phone/TabBar.tsx");
    expect(TABS.map((t) => TAB_LABEL[t])).toEqual(["Home", "Inbox", "Agents", "More"]);
    expect(navLabel("inbox", 0)).toBe("Inbox");
    expect(navLabel("inbox", 1)).toBe("Inbox, 1 waiting");
    expect(navLabel("inbox", 3)).toBe("Inbox, 3 waiting");
    expect(navLabel("inbox", 100)).toBe("Inbox, 99+ waiting");
    expect(badgeText(99)).toBe("99");
    expect(badgeText(250)).toBe("99+");
    expect(navLabel("home", 0)).toBe("Home");
  });
});
