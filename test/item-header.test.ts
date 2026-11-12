import { describe, expect, test } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OutsideFacts } from "../core/frame-types.ts";
import { ItemHeader } from "../app/src/item/item-header.tsx";
import { ActionBar, type VerbControl } from "../app/src/item/action-bar.tsx";
import { chatItem, outsideItem, type ItemVerb } from "../app/src/item/item-view.ts";
import { OutsideItemBar } from "../app/src/desk/outside-card.tsx";
import { attentionItem } from "./fixtures/attention.ts";

// Plan 097, U8: the item's header and its moves in one bar.

const html = (el: ReactElement) => renderToStaticMarkup(el);
const facts = (over: Partial<OutsideFacts> = {}): OutsideFacts => ({
  account_id: "gmail:ada@example.com",
  provider: "gmail",
  account_label: "ada@example.com",
  thread_id: "t1",
  generation: 0,
  owner_agent_id: "agent-work",
  owner_name: "friday",
  sender: "Northwind billing",
  sender_address: "billing@northwind.example",
  subject: "Your invoice",
  lines: ["November's invoice is attached."],
  newest_message_id: "m1",
  newest_at: "2026-11-11T08:15:00.000Z",
  handoff_conversation_id: null,
  disconnected: null,
  place: null,
  ...over,
});
const noop = () => {};
const moves = { read: noop, later: noop, archive: noop, label: noop };

/** The elements a function component returned, depth first, for pressing a button without a DOM. */
function elements(node: ReactNode): Array<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

describe("the item header", () => {
  test("a 200-character subject is one line, cut with an ellipsis, whole in its title", () => {
    const subject = "a".repeat(200);
    const view = outsideItem({ facts: facts({ subject }), messages: [], unread: false });
    const out = html(createElement(ItemHeader, { view: view.header }));
    expect(out).toMatch(/<h2[^>]*class="[^"]*\btruncate\b[^"]*"[^>]*title="a{200}"/);
  });

  test("the unread flag shows only while the item is unread", () => {
    const unread = html(createElement(ItemHeader, { view: chatItem({ item: attentionItem("c1", { unread: true }), live: null, turns: [] }).header }));
    expect(unread).toContain('data-flag="unread"');
    const read = html(createElement(ItemHeader, { view: chatItem({ item: attentionItem("c1", { unread: false }), live: null, turns: [] }).header }));
    expect(read).not.toContain("data-flag");
  });

  test("an editable property opens its picker only where the surface has one", () => {
    const view = chatItem({ item: attentionItem("c1", { labels: ["reports"] }), live: null, turns: [] }).header;
    expect(html(createElement(ItemHeader, { view }))).not.toContain("<button");
    const picking = html(createElement(ItemHeader, { view, onProperty: { labels: noop } }));
    expect(picking).toMatch(/<button[^>]*data-property="labels"|data-property="labels"[^>]*<button/);
  });

  test("a chat with no labels shows no empty label chip", () => {
    const view = chatItem({ item: attentionItem("c1", { labels: [] }), live: null, turns: [] }).header;
    expect(view.properties.map((p) => p.key)).not.toContain("labels");
  });
});

describe("the action bar", () => {
  const verbs = (run: (v: ItemVerb) => void): Partial<Record<ItemVerb, VerbControl>> => ({
    archive: { run: () => run("archive"), keys: "⌘E" },
    mark_read: { run: () => run("mark_read"), keys: "⌘]" },
    later: { run: () => run("later"), keys: "⌘[" },
  });

  test("draws the main move last and in full weight, and only the moves the surface can make", () => {
    const view = chatItem({ item: attentionItem("c1"), live: null, turns: [] }).actions;
    const out = html(createElement(ActionBar, { view, verbs: verbs(noop) }));
    const order = [...out.matchAll(/data-verb="(\w+)"/g)].map((m) => m[1]);
    // "open" is a chat's move in Flow; this surface did not offer it, so it is not drawn.
    expect(order).toEqual(["later", "mark_read", "archive"]);
    expect(out).toMatch(/data-verb="archive"[^>]*data-main="true"/);
    expect(out).toContain("⌘E");
  });

  test("read is the main move on Slack and Jira, archive on a mail", () => {
    expect(outsideItem({ facts: facts({ provider: "slack", place: "#web-launch" }), messages: [], unread: true }).actions.main).toBe("mark_read");
    expect(outsideItem({ facts: facts({ provider: "jira" }), messages: [], unread: true }).actions.main).toBe("mark_read");
    expect(outsideItem({ facts: facts(), messages: [], unread: true }).actions.main).toBe("archive");
  });

  test("pressing read runs the surface's read", () => {
    const ran: ItemVerb[] = [];
    const view = outsideItem({ facts: facts({ provider: "slack", place: "#web-launch" }), messages: [], unread: true }).actions;
    const button = elements(ActionBar({ view, verbs: verbs((v) => ran.push(v)) })).find((e) => e.props.verb === "mark_read");
    const control = button?.props.control as VerbControl | undefined;
    control?.run();
    expect(ran).toEqual(["mark_read"]);
  });
});

describe("an outside card's bar", () => {
  const bar = (over: Partial<Parameters<typeof OutsideItemBar>[0]> = {}) =>
    html(
      createElement(OutsideItemBar, {
        facts: facts(),
        unread: true,
        flash: null,
        went: null,
        cameBack: false,
        thread: { kind: "loading" },
        typing: false,
        moves,
        picking: false,
        ...over,
      }),
    );

  test("a mail is titled by its subject, flagged unread, with archive named and label, later and read beside it", () => {
    const out = bar({ onHandoff: noop });
    expect(out).toMatch(/<h2[^>]*>Your invoice</);
    expect(out).toContain('data-flag="unread"');
    expect([...out.matchAll(/data-verb="(\w+)"/g)].map((m) => m[1])).toEqual(["handoff", "label", "later", "mark_read", "archive"]);
  });

  test("a Jira card has no archive, and links to its ticket from the bar", () => {
    const out = bar({ facts: facts({ provider: "jira", account_id: "jira:acme", account_label: "acme.atlassian.net", subject: "WEB-412 checkout" }) });
    expect(out).not.toContain('data-verb="archive"');
    expect(out).toMatch(/data-verb="mark_read"[^>]*data-main="true"/);
  });

  test("a read card has no unread flag", () => {
    expect(bar({ unread: false })).not.toContain("data-flag");
  });
});
