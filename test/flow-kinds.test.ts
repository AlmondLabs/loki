import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AttentionItem } from "../core/attention/model.ts";
import { idOf } from "../core/attention/queue.ts";
import { kindItems, kindOf, offeredKinds } from "../app/src/desk/flow-kinds.ts";
import { kindPills } from "../app/src/desk/flow-column.tsx";
import { switchLane } from "../app/src/desk/use-deck-queue.ts";
import { FilterPills } from "../app/src/shell/filter-pills.tsx";
import { attentionItem } from "./fixtures/attention.ts";
import { jiraItem, outsideItem } from "./fixtures/outside-item.ts";

const chat = attentionItem("c1", { agent_id: "ira", agent_name: "ira", runtime: { agent_id: "ira", conversation_id: "c1" } });
const mail = outsideItem("Your invoice");
const base = outsideItem("Launch");
const slack: AttentionItem = {
  ...base,
  id: "s1#1",
  agent_id: "account:slack:acme",
  outside: base.outside && { ...base.outside, provider: "slack", account_id: "slack:acme", thread_id: "s1", place: "#launch" },
};
const jira = jiraItem();
const all = [chat, mail, slack, jira];
const ids = (items: readonly AttentionItem[]) => items.map(idOf);

describe("Flow's kinds", () => {
  test("a card's kind is its account's provider, or a chat", () => {
    expect(all.map(kindOf)).toEqual(["chat", "gmail", "slack", "jira"]);
  });

  test("each kind keeps only its cards, in their order, and All keeps every card", () => {
    expect(ids(kindItems(all, "all"))).toEqual(ids(all));
    expect(ids(kindItems(all, "gmail"))).toEqual([idOf(mail)]);
    expect(ids(kindItems(all, "slack"))).toEqual([idOf(slack)]);
    expect(ids(kindItems(all, "jira"))).toEqual([idOf(jira)]);
    expect(ids(kindItems(all, "chat"))).toEqual([idOf(chat)]);
  });

  test("the pills are All and the kinds Flow holds, in order; a kind with no card has none", () => {
    expect(offeredKinds(all, "all")).toEqual(["all", "chat", "gmail", "slack", "jira"]);
    expect(offeredKinds([mail, chat], "all")).toEqual(["all", "chat", "gmail"]);
  });

  test("the chosen kind keeps its pill once its last card is gone", () => {
    expect(offeredKinds([chat, mail], "slack")).toEqual(["all", "chat", "gmail", "slack"]);
  });

  test("with one kind there are no pills, since a pill could only show what the list already does", () => {
    expect(offeredKinds([chat], "all")).toEqual([]);
    expect(offeredKinds([], "all")).toEqual([]);
  });

  test("the pills are named and draw the chosen one with its name, the rest as symbols", () => {
    const html = renderToStaticMarkup(createElement(FilterPills<string>, { pills: kindPills(all, "gmail"), value: "gmail", onValue: () => {} }));
    expect([...html.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1])).toEqual(["Show", "All", "Chats", "Mail", "Slack", "Jira"]);
    expect(html).toContain("<span>Mail</span>");
    expect(html).not.toContain("<span>Slack</span>");
  });
});

describe("a kind switch in the deck", () => {
  test("keeps the selected card when the new kind holds it, and sorts the rest afresh", () => {
    const rows = switchLane(all, kindItems(all, "gmail"), null, [], false, idOf(mail), "gmail");
    expect(ids(rows)).toEqual([idOf(mail)]);
  });

  test("does not keep a selected card of another kind", () => {
    const rows = switchLane(all, kindItems(all, "slack"), null, [], false, idOf(mail), "slack");
    expect(ids(rows)).toEqual([idOf(slack)]);
  });
});
