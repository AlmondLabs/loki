import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { agentLaneId, laneItems, type Lane, type ResolvedLane } from "../core/attention/lanes.ts";
import { idOf, inboxQueue } from "../core/attention/queue.ts";
import { flowLanes, flowRows, flowSources } from "../app/src/desk/flow-column.tsx";
import { Places } from "../app/src/shell/sidebar.tsx";
import { attentionItem } from "./fixtures/attention.ts";
import { outsideItem } from "./fixtures/outside-item.ts";

// Plan 2026-11-14-1330, U6: Flow's lanes are sources under its place in the sidebar, as Mail's mailboxes, and the lane's
// cards are the list's rows.

const ira = (id: string, status: "done" | "running" = "done") =>
  attentionItem(id, { agent_id: "ira", agent_name: "ira", status, runtime: { agent_id: "ira", conversation_id: id } });
const friday = (id: string) => attentionItem(id, { agent_id: "friday", agent_name: "friday", runtime: { agent_id: "friday", conversation_id: id } });
const studio: Lane = { id: "studio", name: "Studio", chats: ["friday"], accounts: [] };
const noop = () => {};

describe("Flow's lanes", () => {
  test("Everything, the person's lanes, then each agent busiest first; each counts what needs you, as the badge does", () => {
    const items = [ira("a"), ira("b"), ira("c", "running"), friday("d")];
    const rows = flowLanes(items, null, [studio]);
    expect(rows.map((r) => [r.name, r.count])).toEqual([
      ["Everything", 3],
      ["Studio", 1],
      ["ira", 2],
      ["friday", 1],
    ]);
    expect(rows.map((r) => r.icon)).toEqual(["inbox", "filter", "person", "person"]);
  });

  test("an agent lane cleared while it is on stays listed at 0, so the person sees where they are", () => {
    const empty = { id: agentLaneId("atlas"), name: "atlas", agent_id: "atlas", count: 0 };
    expect(flowLanes([ira("a")], empty, null).map((r) => [r.name, r.count])).toEqual([
      ["Everything", 1],
      ["ira", 1],
      ["atlas", 0],
    ]);
  });
});

describe("the lanes as Flow's sources in the sidebar", () => {
  test("Flow's own row is Everything; the person's lanes and the agents' follow under it, the active one chosen", () => {
    const sources = flowSources([ira("a"), ira("b"), friday("d")], studio, [studio], noop);
    expect(sources.all).toBe("");
    expect(sources.selected).toBe("studio");
    expect(sources.items.map((s) => [s.id, s.title, s.count])).toEqual([
      ["studio", "Studio", 1],
      [agentLaneId("ira"), "ira", 2],
      [agentLaneId("friday"), "friday", 1],
    ]);
    const html = renderToStaticMarkup(createElement(Places, { segment: "inbox", onSelect: noop, waiting: 3, sources: { inbox: sources } }));
    expect(html).toMatch(/aria-current="page"[^>]*aria-label="Studio, 1 waiting"/);
  });

  test("a lane source selects that lane, and the list's rows are that lane's cards in the deck's order", () => {
    const items = [ira("a"), friday("d"), friday("e")];
    const picked: Array<ResolvedLane | null> = [];
    const sources = flowSources(items, null, [studio], (l) => picked.push(l));
    sources.onSelect("studio");
    sources.onSelect("");
    expect(picked).toEqual([studio, null]);
    const queue = inboxQueue(laneItems(items, studio));
    expect(queue.map((i) => i.id)).toEqual(["d", "e"]);
    expect(flowRows(queue).map((r) => r.id)).toEqual(queue.map(idOf));
  });
});

describe("a Flow row", () => {
  const text = (row: ReturnType<typeof flowRows>[number]) =>
    renderToStaticMarkup(createElement("ul", null, createElement("li", null, row.title, row.preview, row.flags)))
      .replace(/<[^>]+>/g, "|")
      .replace(/\|+/g, "|");

  test("a chat's says its agent, its name, a line of what was said last, and the chat's symbol", () => {
    const [row] = flowRows([attentionItem("c1", { agent_name: "ira", title: "Signups", lastAssistantText: "Done.\nMore below." })]);
    expect(text(row)).toBe("|ira|Signups|Done.|");
    expect(renderToStaticMarkup(createElement("span", null, row.lead))).toContain("loki-list-icon");
  });

  test("a mail's says its sender, its subject and its newest line, with no Sign In mark while its account is fine", () => {
    const [row] = flowRows([outsideItem("Your invoice")]);
    expect(text(row)).toBe("|Grace|Your invoice|Can you look?|");
  });

  test("a card whose account needs a sign-in carries a muted Sign In mark", () => {
    const base = outsideItem("Your invoice");
    const out = base.outside ? { ...base.outside, disconnected: "sign_in_again" as const } : undefined;
    const [row] = flowRows([{ ...base, outside: out }]);
    expect(renderToStaticMarkup(createElement("span", null, row.flags))).toContain(">Sign In<");
  });
});
