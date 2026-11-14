import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { agentLaneId, type Lane } from "../core/attention/lanes.ts";
import { FlowColumn, flowLanes } from "../app/src/desk/flow-column.tsx";
import { attentionItem } from "./fixtures/attention.ts";

// Plan 2026-11-14-1130, 1: Flow's lanes are sidebar rows, each with what in it needs the person, as Mail's mailboxes.

const ira = (id: string, status: "done" | "running" = "done") =>
  attentionItem(id, { agent_id: "ira", agent_name: "ira", status, runtime: { agent_id: "ira", conversation_id: id } });
const friday = (id: string) => attentionItem(id, { agent_id: "friday", agent_name: "friday", runtime: { agent_id: "friday", conversation_id: id } });
const studio: Lane = { id: "studio", name: "Studio", chats: ["friday"], accounts: [] };

describe("Flow's lanes in the sidebar", () => {
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

  test("the active lane is the chosen row; a lane with nothing for you shows no count; New Lane is in the header", () => {
    const html = renderToStaticMarkup(createElement(FlowColumn, { items: [ira("a")], lane: studio, lanes: [studio], onLane: () => {}, onNewLane: () => {} }));
    expect(html).toContain('aria-label="Studio, 0 need you"');
    expect(html).toMatch(/aria-current="page"[^>]*aria-label="Studio, 0 need you"|aria-label="Studio, 0 need you"[^>]*aria-current="page"/);
    expect(html).toContain('aria-label="New lane"');
    // One heading: the column's.
    expect(html.match(/>Lanes</g)?.length).toBe(1);
  });
});
