import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { labelQuery, type LabelView } from "../core/labels.ts";
import { LOKI_COMMANDS } from "../core/attention/commands.ts";
import type { DeskSummary } from "../core/frame-types.ts";
import { LabelChips, LabelEditor, labelColor, labelCommand } from "../app/src/chat/labels.tsx";
import { canLabel, sidebarModel } from "../app/src/shell/sidebar-model.ts";
import { buildIndex, placeHit, search, type SearchSources } from "../app/src/shell/search-model.ts";

/** Labels on chats in the app (plan 022, unit 2): the filter, chips, the picker, `/label` and ⌘K. */

const desk = (scope: string, over: Partial<DeskSummary> = {}): DeskSummary => ({
  scope,
  title: scope,
  status: "live",
  agent_name: "friday",
  agent_id: "a1",
  conversation_id: scope,
  model: null,
  reasoning_effort: null,
  pinned: false,
  widgets: 0,
  active: false,
  last_active: "2026-09-08T10:00:00Z",
  ...over,
});
const LIST: LabelView[] = [
  { name: "billing", color: 1, chats: 1 },
  { name: "infra", color: 5, chats: 2 },
];
const shown = (query: string, desks: DeskSummary[]) =>
  sidebarModel(desks, [], { query })
    .sections.flatMap((s) => s.rows)
    .map((r) => r.desk.scope);

describe("the label: filter (R4)", () => {
  test("label: terms are label names; the words left are the text", () => {
    expect(labelQuery("label:Infra deploy  label:client-x")).toEqual({ labels: ["infra", "client-x"], text: "deploy" });
    expect(labelQuery("label: ops")).toEqual({ labels: [], text: "ops" });
    expect(labelQuery("")).toEqual({ labels: [], text: "" });
  });

  test("the sidebar keeps chats with every label named, across agents, then matches the words left", () => {
    const desks = [
      desk("deploy", { labels: ["infra"] }),
      desk("bill", { labels: ["infra", "billing"] }),
      desk("notes", { agent_id: "a2", agent_name: "ira", labels: ["infra"] }),
      desk("plain"),
    ];
    expect(shown("label:infra", desks).sort()).toEqual(["bill", "deploy", "notes"]);
    expect(shown("label:infra label:billing", desks)).toEqual(["bill"]);
    expect(shown("label:infra dep", desks)).toEqual(["deploy"]);
    expect(sidebarModel(desks, [], { query: "label:nothing" }).empty).toBe(true);
    expect(sidebarModel(desks, [], { query: "" }).empty).toBe(false);
  });

  test("any chat with an agent and a conversation can carry labels, a main chat too; a deleted one cannot", () => {
    expect(canLabel(desk("x"))).toBe(true);
    expect(canLabel(desk("default-a1", { conversation_id: "default" }))).toBe(true);
    expect(canLabel(desk("gone", { status: "deleted" }))).toBe(false);
    expect(canLabel(desk("shared", { agent_id: null, conversation_id: null }))).toBe(false);
  });
});

describe("chips (R3)", () => {
  test("a label takes the colour the daemon gave it, else one from its name, always one of the palette", () => {
    expect(labelColor("infra", LIST)).toBe("var(--loki-label-5)");
    expect(labelColor("new-one", null)).toMatch(/^var\(--loki-label-[0-7]\)$/);
    expect(labelColor("new-one", null)).toBe(labelColor("new-one", []));
  });

  test("a row shows two and +N; header chips are buttons that pick the label; none shows nothing", () => {
    const row = renderToStaticMarkup(createElement(LabelChips, { labels: ["infra", "billing", "q3", "ops"], list: LIST, max: 2 }));
    expect([...row.matchAll(/class="loki-label-chip"[^>]*>.*?<\/span>([^<]+)</g)].map((m) => m[1])).toEqual(["infra", "billing"]);
    expect(row).toContain(">+2<");
    expect(row).toContain('title="q3, ops"');
    expect(row).not.toContain("<button");
    const picked: string[] = [];
    const header = createElement(LabelChips, { labels: ["infra"], list: LIST, onPick: (n: string) => picked.push(n) });
    expect(renderToStaticMarkup(header)).toContain('<button type="button" class="loki-label-chip"');
    expect(renderToStaticMarkup(createElement(LabelChips, { labels: [], list: LIST }))).toBe("");
  });
});

describe("a sidebar row's labels", () => {
  test("only the colours, three and +N, with every name in the tooltip and for a screen reader", () => {
    const html = renderToStaticMarkup(createElement(LabelChips, { labels: ["infra", "billing", "q3", "ops"], list: LIST, max: 3, dots: true }));
    expect(html.match(/class="loki-label-dot"/g)).toHaveLength(3);
    expect(html).toContain('title="infra, billing, q3, ops"');
    expect(html).toContain('<span class="sr-only">labels: infra, billing, q3, ops</span>');
    expect(html).toContain(">+1<");
    expect(html).not.toContain("loki-label-chip");
  });
});

describe("the labels… picker (R1)", () => {
  test("the chat's own labels first, ticked; then the rest; a field to find or make one", () => {
    const html = renderToStaticMarkup(createElement(LabelEditor, { current: ["infra"], list: LIST, onChange: () => Promise.resolve(null) }));
    expect(html).toContain('aria-label="Find or create a label"');
    const options = [...html.matchAll(/role="checkbox" aria-checked="(true|false)".*?loki-label-option-name">([^<]+)</g)].map((m) => [m[2], m[1]]);
    expect(options).toEqual([
      ["infra", "true"],
      ["billing", "false"],
    ]);
  });

  test("with no labels yet it says how to make one", () => {
    expect(renderToStaticMarkup(createElement(LabelEditor, { current: [], list: [], onChange: () => Promise.resolve(null) }))).toContain(
      "No labels yet: type one to make it",
    );
  });

  test("/label is loki's own, with a name to add", () => {
    expect(LOKI_COMMANDS.find((c) => c.id === "label")).toMatchObject({ where: "loki", args: "[label]" });
  });

  test("/label Client X adds client-x; one it has already, or a ninth, is not added; /label alone opens the picker", async () => {
    const saved: string[][] = [];
    const save = (labels: string[]) => (saved.push(labels), Promise.resolve(null));
    expect(await labelCommand("Client X", ["infra"], save)).toBeNull();
    expect(saved).toEqual([["infra", "client-x"]]);
    expect(await labelCommand("infra", ["infra"], save)).toBeNull();
    expect(saved).toHaveLength(1);
    expect(await labelCommand("ninth", ["a", "b", "c", "d", "e", "f", "g", "h"], save)).toBe("a chat holds 8 labels at most");
    let opened = 0;
    expect(await labelCommand("", ["infra"], save, () => opened++)).toBeNull();
    expect(opened).toBe(1);
    expect(await labelCommand("  ", [], save)).toBe("name a label: /label infra");
  });
});

describe("⌘K finds labels (R5)", () => {
  const src: SearchSources = { desks: [desk("deploy", { labels: ["infra"] })], agents: [{ id: "a1", name: "friday" }], items: [], labels: LIST };

  test("a label is a result of its own, saying how many chats carry it; choosing it shows the label's chats", () => {
    const groups = search(buildIndex(src), "infr");
    const labels = groups.find((g) => g.id === "labels");
    expect(labels?.title).toBe("Labels");
    expect(labels?.hits.map((h) => [h.title, h.preview, h.target])).toEqual([["infra", "Label · 2 chats", { kind: "label", name: "infra" }]]);
  });

  test("a label opened before is among the recent places while it exists", () => {
    expect(placeHit("label:billing", src)?.preview).toBe("Label · 1 chat");
    expect(placeHit("label:gone", src)).toBeNull();
  });
});
