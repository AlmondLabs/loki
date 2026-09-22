import { describe, expect, test } from "bun:test";
import type { AttentionItem } from "../core/attention/model.ts";
import type { DeskSummary } from "../app/src/desk/useDesk";
import { formatRoute } from "../app/src/phone/router.ts";
import { createRecents } from "../app/src/phone/session.ts";
import { DESTINATIONS, GROUP_MAX, MAX_QUERY, buildIndex, cleanQuery, isPlace, recentPlaceHits, search, tierOf, type SearchSources } from "../app/src/phone/searchIndex.ts";

/**
 * The phone's local Search (app/src/phone/searchIndex.ts): what it matches (declared fields only — desk
 * titles and agents, agent names and descriptions, the loaded Inbox items, the named pages), how it ranks,
 * and how the recent histories resolve to rows with the stale ones dropped.
 */

const desk = (title: string | null, over: Partial<DeskSummary> = {}): DeskSummary => ({
  scope: `s-${title}`,
  title,
  status: "live",
  agentName: "Friday",
  agentId: "a1",
  conversationId: `c-${title}`,
  model: null,
  reasoningEffort: null,
  widgets: 0,
  active: false,
  lastActive: "2026-09-20T10:00:00Z",
  ...over,
});

const item = (id: string, title: string, over: Partial<AttentionItem> = {}): AttentionItem =>
  ({
    id,
    agentId: "a2",
    agentName: "Ledger",
    title,
    lastMessageAt: "2026-09-21T10:00:00Z",
    archived: false,
    status: "question",
    lastAssistantText: "the banana report is ready",
    lastRole: "assistant",
    pendingApproval: null,
    pendingQuestion: null,
    turns: 1,
    error: null,
    seenAt: null,
    unread: true,
    lastAsk: null,
    score: 1,
    reason: "asked",
    runtime: { agent_id: "a2", conversation_id: id },
    ...over,
  }) as AttentionItem;

const src = (over: Partial<SearchSources> = {}): SearchSources => ({
  desks: [desk("Loki mobile"), desk("Mobile budget", { conversationId: "c2", lastActive: "2026-09-22T10:00:00Z" }), desk("Automobile notes", { conversationId: "c3" })],
  agents: [
    { id: "a1", name: "Friday" },
    { id: "a2", name: "Ledger" },
  ],
  describe: (id) => (id === "a2" ? "Keeps the household accounts" : null),
  items: [item("i1", "Approve the invoice")],
  ...over,
});

const titles = (s: SearchSources, q: string, group: string) => search(s, q).find((g) => g.id === group)?.hits.map((h) => h.title) ?? [];

describe("matching", () => {
  test("a blank query is no results (the recents show instead)", () => {
    expect(search(src(), "")).toEqual([]);
    expect(search(src(), "   ")).toEqual([]);
  });
  test("case-insensitive, accents folded, whitespace collapsed", () => {
    expect(titles(src(), "LOKI", "desks")).toEqual(["Loki mobile"]);
    expect(titles(src(), "  loki    MOBILE ", "desks")).toEqual(["Loki mobile"]);
    expect(titles(src({ desks: [desk("Café plans")] }), "cafe", "desks")).toEqual(["Café plans"]);
  });
  test("category-aware: each kind lands in its own group, in a fixed order", () => {
    const s = src({ desks: [desk("Ledger sync")] });
    const groups = search(s, "ledger");
    expect(groups.map((g) => g.id)).toEqual(["desks", "agents", "inbox"]);
    expect(groups[0].hits[0].route).toEqual({ kind: "conversation", agentId: "a1", conversationId: "c-Ledger sync", prefill: null });
    expect(groups[1].hits[0].route).toEqual({ kind: "agent", agentId: "a2" });
    expect(groups[2].hits[0].route).toEqual({ kind: "conversation", agentId: "a2", conversationId: "i1", prefill: null });
  });
  test("only declared fields: a word that is only in a transcript does not match", () => {
    expect(search(src(), "banana")).toEqual([]);
  });
  test("an agent's description matches once it is loaded", () => {
    expect(titles(src(), "household", "agents")).toEqual(["Ledger"]);
    expect(titles(src({ describe: () => null }), "household", "agents")).toEqual([]);
  });
  test("desk agent names match; desks the phone cannot open are left out", () => {
    expect(titles(src(), "friday", "desks").length).toBe(3);
    expect(titles(src({ desks: [desk("Orphan", { conversationId: null })] }), "orphan", "desks")).toEqual([]);
  });
  test("named pages match by name and by the words people use for them", () => {
    expect(titles(src(), "prefer", "pages")).toEqual(["Preferences"]);
    expect(titles(src(), "theme", "pages")).toEqual(["Preferences"]);
    expect(titles(src(), "archive", "pages")).toContain("Archived desks");
    expect(search(src(), "connection").find((g) => g.id === "pages")?.hits[0].route).toEqual({ kind: "connection" });
    for (const d of DESTINATIONS) expect(d.route.kind).not.toBe("search");
  });
  test("the inbox holds the loaded actionable items only", () => {
    const s = src({ items: [item("i1", "Approve the invoice"), item("i2", "Invoice draft", { status: "running" }), item("i3", "Invoice idle", { status: "idle" })] });
    expect(titles(s, "invoice", "inbox")).toEqual(["Approve the invoice"]);
  });
  test("deterministic: the same query on the same data gives the same answer", () => {
    expect(search(src(), "mobile")).toEqual(search(src(), "mobile"));
  });
  test("an index built once answers every keystroke the same as the sources would, without reading them again", () => {
    let described = 0;
    const s = src({ describe: (id) => (described++, id === "a2" ? "Keeps the household accounts" : null) });
    const idx = buildIndex(s);
    const built = described;
    for (const q of ["l", "le", "led", "household", "Café"]) expect(search(idx, q)).toEqual(search(src(), q));
    expect(described).toBe(built);
  });
});

describe("ranking", () => {
  test("tiers: exact, then prefix, then word start, then substring", () => {
    expect(tierOf("mobile", "mobile")).toBe(0);
    expect(tierOf("mobile budget", "mobile")).toBe(1);
    expect(tierOf("loki mobile", "mobile")).toBe(2);
    expect(tierOf("automobile", "mobile")).toBe(3);
    expect(tierOf("loki", "mobile")).toBe(null);
  });
  test("prefix before word start before substring", () => {
    expect(titles(src(), "mobile", "desks")).toEqual(["Mobile budget", "Loki mobile", "Automobile notes"]);
  });
  test("a title match beats an agent-name match of the same tier", () => {
    // both exact; the older desk named Atlas still comes before the newer one whose agent is Atlas
    const s = src({ desks: [desk("Notes", { agentName: "Atlas", conversationId: "n1" }), desk("Atlas", { agentName: "Friday", conversationId: "n2", lastActive: "2026-01-01T00:00:00Z" })] });
    expect(titles(s, "atlas", "desks")).toEqual(["Atlas", "Notes"]);
  });
  test("ties break by recency, newest first, then by list order", () => {
    const s = src({
      desks: [desk("Plan A", { conversationId: "p1", lastActive: "2026-09-01T00:00:00Z" }), desk("Plan B", { conversationId: "p2", lastActive: "2026-09-10T00:00:00Z" }), desk("Plan C", { conversationId: "p3", lastActive: null }), desk("Plan D", { conversationId: "p4", lastActive: null })],
    });
    expect(titles(s, "plan", "desks")).toEqual(["Plan B", "Plan A", "Plan C", "Plan D"]);
  });
  test("each group is capped, and says how many matched", () => {
    const many = Array.from({ length: 12 }, (_, i) => desk(`Report ${i}`, { conversationId: `r${i}` }));
    const g = search(src({ desks: many }), "report").find((x) => x.id === "desks")!;
    expect(g.hits).toHaveLength(GROUP_MAX);
    expect(g.total).toBe(12);
  });
});

describe("long and odd queries", () => {
  test("a long query is cut to MAX_QUERY and still answers", () => {
    const long = "loki ".repeat(100);
    expect(cleanQuery(long).length).toBeLessThanOrEqual(MAX_QUERY);
    expect(() => search(src(), long)).not.toThrow();
    expect(search(src(), long)).toEqual([]);
  });
  test("regex characters are text", () => {
    expect(() => search(src(), "(.*[")).not.toThrow();
    expect(titles(src({ desks: [desk("C++ (build)")] }), "c++ (", "desks")).toEqual(["C++ (build)"]);
  });
  test("cleanQuery keeps case for display and trims", () => {
    expect(cleanQuery("  Loki   Mobile  ")).toBe("Loki Mobile");
  });
});

describe("recent places", () => {
  const conv = formatRoute({ kind: "conversation", agentId: "a1", conversationId: "c-Loki mobile", prefill: null });
  const inboxConv = formatRoute({ kind: "conversation", agentId: "a2", conversationId: "i1", prefill: null });
  const agent = formatRoute({ kind: "agent", agentId: "a2" });
  const file = formatRoute({ kind: "file", agentId: "a2", path: "notes/today.md" });
  test("each kind of place resolves to a row that opens it", () => {
    const hits = recentPlaceHits([conv, inboxConv, agent, file, "#/learn", "#/preferences", "#/inbox"], src());
    expect(hits.map((h) => h.title)).toEqual(["Loki mobile", "Approve the invoice", "Ledger", "today.md", "Learn", "Preferences", "Inbox"]);
    for (const h of hits) expect(formatRoute(h.route)).toBeString();
    expect(hits[0].route).toEqual({ kind: "conversation", agentId: "a1", conversationId: "c-Loki mobile", prefill: null });
  });
  test("stale places are dropped: a deleted desk, a gone agent, a junk hash, Search itself", () => {
    const gone = formatRoute({ kind: "conversation", agentId: "a1", conversationId: "deleted", prefill: null });
    const ghost = formatRoute({ kind: "agent", agentId: "nobody" });
    const s = src();
    for (const h of [gone, ghost, "#/nowhere", "#/search", "garbage", "#/agents/nobody/file/x.md"]) expect(isPlace(h, s)).toBe(false);
    expect(recentPlaceHits([gone, conv, ghost, "#/nowhere"], s).map((h) => h.title)).toEqual(["Loki mobile"]);
  });
  test("the recents store, read through isPlace, hands back only valid places, bounded", () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    let now = 1;
    const places = createRecents({ storage, key: "p", max: 4, now: () => now++ });
    for (const h of ["#/learn", "#/nowhere", conv, "#/archive", agent, "#/about"]) places.add(h);
    const s = src();
    const read = places.read((h) => isPlace(h, s));
    expect(read).toEqual(["#/about", agent, "#/archive", conv]);
    expect(read.length).toBeLessThanOrEqual(4);
  });
});

describe("recent searches", () => {
  test("remove takes one entry out; clear takes all", () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    let now = 1;
    const r = createRecents({ storage, key: "s", max: 8, now: () => now++ });
    r.add("alpha");
    r.add("beta");
    r.add("gamma");
    r.remove("beta");
    expect(r.read()).toEqual(["gamma", "alpha"]);
    r.clear();
    expect(r.read()).toEqual([]);
  });
});
