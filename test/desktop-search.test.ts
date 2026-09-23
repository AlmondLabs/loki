import { describe, expect, test } from "bun:test";
import { buildIndex, flatHits, PLACES_KEY, recentPlaceHits, search, topHit, type SearchSources } from "../app/src/shell/searchModel.ts";
import { createRecents } from "../app/src/shared/recents.ts";
import type { DeskSummary } from "../app/src/desk/useDesk";
import type { AttentionItem } from "../core/attention/model.ts";

/**
 * The desktop's ⌘K search (app/src/shell/searchModel.ts, plan 013 U9): desks by title and agent, agents,
 * waiting Inbox items and the app's pages, from what the window already holds — never message text.
 * Enter opens the top result; before typing, the recent places, stale ones dropped at read.
 */

const desk = (scope: string, over: Partial<DeskSummary> = {}): DeskSummary =>
  ({ scope: scope as DeskSummary["scope"], title: scope, status: "live", agentName: "friday", agentId: "a1", conversationId: scope, model: null, reasoningEffort: null, pinned: false, widgets: 0, active: false, lastActive: "2026-09-08T10:00:00Z", ...over }) as DeskSummary;
const item = (id: string, over: Partial<AttentionItem> = {}): AttentionItem => ({ id, agentId: "a1", agentName: "friday", title: id, status: "approval", lastMessageAt: "2026-09-08T10:00:00Z", lastAssistantText: "the quarterly zebra forecast", ...over }) as unknown as AttentionItem;

const src: SearchSources = {
  desks: [desk("a1/c-rev", { title: "Revenue dashboard", conversationId: "c-rev" }), desk("a1/c-ops", { title: "Ops review", conversationId: "c-ops" }), desk("a1/default", { title: null, conversationId: "default" }), desk("shared", { title: "shared sheet", agentId: null, conversationId: null }), desk("a1/c-old", { title: "Old notes", conversationId: "c-old", status: "archived" })],
  agents: [
    { id: "a1", name: "friday" },
    { id: "a2", name: "ira" },
  ],
  items: [item("c-ops", { title: "Deploy the ops fix" }), item("c-run", { title: "Running thing", status: "running" })],
};
const titles = (raw: string) => search(buildIndex(src), raw).map((g) => [g.id, g.hits.map((h) => h.title)]);

describe("desktop search: what it finds (AE5)", () => {
  test("part of a desk's title finds the desk, and it opens on Messages (a desk target)", () => {
    const groups = search(buildIndex(src), "venue");
    expect(groups.map((g) => g.id)).toEqual(["desks"]);
    expect(topHit(groups)?.target).toEqual({ kind: "desk", agentId: "a1", conversationId: "c-rev" });
  });
  test("a word only in a message body finds nothing", () => {
    expect(search(buildIndex(src), "zebra")).toEqual([]);
    expect(search(buildIndex(src), "quarterly")).toEqual([]);
  });
  test("agents, waiting items and pages; the shared scope and not-waiting items are left out", () => {
    expect(titles("ira")).toEqual([["agents", ["ira"]]]);
    expect(titles("deploy")).toEqual([["waiting", ["Deploy the ops fix"]]]);
    expect(titles("shared")).toEqual([]);
    expect(titles("running")).toEqual([]);
    expect(titles("appearance")).toEqual([["pages", ["Appearance"]]]);
  });
  test("an agent's name finds its desks too, by the secondary field; the main chat reads as Main chat", () => {
    const g = search(buildIndex(src), "friday");
    expect(g[0].id).toBe("agents"); // the name is the agent's title, a desk's secondary field
    expect(g.find((x) => x.id === "desks")!.hits.map((h) => h.title)).toContain("Main chat");
  });
  test("archived desks show, quieter; pages open the section or Preferences on the page", () => {
    const old = flatHits(search(buildIndex(src), "old notes"))[0];
    expect(old.dim).toBe(true);
    expect(topHit(search(buildIndex(src), "board"))?.target).toEqual({ kind: "section", segment: "board" });
    expect(topHit(search(buildIndex(src), "providers"))?.target).toEqual({ kind: "preferences", page: "providers" });
    expect(topHit(search(buildIndex(src), "preferences"))?.target).toEqual({ kind: "preferences", page: null });
    expect(topHit(search(buildIndex(src), "ira"))?.target).toEqual({ kind: "agent", agentId: "a2" });
    expect(topHit(search(buildIndex(src), "deploy"))?.target).toEqual({ kind: "desk", agentId: "a1", conversationId: "c-ops" });
  });
  test("Enter's top result is the first row drawn: groups come in the order of their best hit", () => {
    const groups = search(buildIndex(src), "ops");
    expect(groups[0].id).toBe("desks"); // "Ops review" is a prefix; the waiting item only a word start
    expect(topHit(groups)).toBe(flatHits(groups)[0]);
    expect(topHit(search(buildIndex(src), "   "))).toBeNull();
  });
});

describe("desktop search: recent places", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };
  test("under the desktop's own key, bounded, newest first, a repeat moves up", () => {
    expect(PLACES_KEY.startsWith("loki.desktop.")).toBe(true);
    let t = 0;
    const r = createRecents({ storage: memory(), key: PLACES_KEY, max: 3, now: () => ++t });
    for (const k of ["page:inbox", "desk:a1/c-rev", "page:board", "desk:a1/c-rev", "agent:a2"]) r.add(k);
    expect(r.read()).toEqual(["agent:a2", "desk:a1/c-rev", "page:board"]);
  });
  test("desks and agents that are gone drop at read; junk drops; the rest become rows", () => {
    const hits = recentPlaceHits(["desk:a1/c-rev", "desk:a1/c-gone", "agent:a9", "agent:a2", "page:learn", "prefs:keys", "prefs:nope", "nonsense"], src);
    expect(hits.map((h) => h.title)).toEqual(["Revenue dashboard", "ira", "Learn", "Keys"]);
  });
});
