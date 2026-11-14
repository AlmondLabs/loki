import { describe, expect, test } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OutsideFacts } from "../core/frame-types.ts";
import { chatItem, outsideItem } from "../app/src/item/item-view.ts";
import type { ToolbarMove } from "../app/src/item/toolbar.tsx";
import type { AttentionItem } from "../core/attention/model.ts";
import { ChatItemHeader, type ChatMoves } from "../app/src/desk/catch-up-parts.tsx";
import { OutsideItemActions, OutsideItemHeader } from "../app/src/desk/outside-card.tsx";
import { attentionItem } from "./fixtures/attention.ts";

// Plan 097, U8: the item's header; plan 2026-11-14-1330, U6: a Flow card's toolbar, its moves as symbols.

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

describe("the item's title", () => {
  test("a 200-character subject is one line in the toolbar, whole in its tooltip", () => {
    const subject = "a".repeat(200);
    const out = html(
      createElement(OutsideItemHeader, { facts: facts({ subject }), unread: false, flash: null, went: null, cameBack: false, thread: { kind: "loading" } }),
    );
    expect(out).toMatch(/<h2 class="loki-toolbar-name" title="a{200}"/);
  });

  test("a chat with no labels shows no empty label chip", () => {
    const view = chatItem({ item: attentionItem("c1", { labels: [] }), live: null, turns: [] }).header;
    expect(view.properties.map((p) => p.key)).not.toContain("labels");
  });
});

/** The toolbar items drawn, by name, in order, each with whether it is prominent and whether it is off. */
const items = (out: string) =>
  [...out.matchAll(/<button[^>]*class="(loki-toolbar-item[^"]*)"[^>]*aria-label="([^"]+)"([^>]*)>/g)].map((m) => ({
    label: m[2],
    prominent: m[1].includes("--prominent"),
    off: m[3].includes("disabled"),
  }));

describe("a chat card's moves as toolbar symbols (plan 2026-11-14-1330, R10)", () => {
  const chatMoves = (item: AttentionItem, over: Partial<ChatMoves> = {}): ChatMoves => ({
    current: item,
    typing: false,
    read: noop,
    later: noop,
    archive: noop,
    onOpenDesk: noop,
    onClose: noop,
    ...over,
  });
  const chat = (over: Partial<ChatMoves> = {}, item = attentionItem("c1")) =>
    html(createElement(ChatItemHeader, { current: item, cameBack: false, flash: null, moves: chatMoves(item, over) }));

  test("Later, Mark as Read, then Archive, the one prominent item", () => {
    const out = items(chat());
    expect(out.map((i) => i.label)).toEqual(["Later", "Mark as Read", "Archive"]);
    expect(out.filter((i) => i.prominent).map((i) => i.label)).toEqual(["Archive"]);
  });

  test("an approval card's toolbar shows Approve and Deny before the moves; a card with nothing to approve has neither", () => {
    const pendingApproval = { requestId: "r1", toolName: "edit", input: {}, at: "" } as unknown as AttentionItem["pendingApproval"];
    const item = attentionItem("c1", { status: "approval", pendingApproval });
    expect(items(chat({ approve: noop }, item)).map((i) => i.label)).toEqual(["Approve", "Deny", "Later", "Mark as Read", "Archive"]);
    expect(items(chat({ approve: noop })).map((i) => i.label)).not.toContain("Approve");
  });

  test("a card answered elsewhere keeps its moves in view, every one of them off", () => {
    expect(items(chat({ off: true })).every((i) => i.off)).toBe(true);
  });

  test("pressing Mark as Read runs the card's read", () => {
    const ran: string[] = [];
    const item = attentionItem("c1");
    const group = elements(ChatItemHeader({ current: item, cameBack: false, flash: null, moves: chatMoves(item, { read: () => ran.push("read") }) })).find(
      (e) => e.props.label === "Chat actions",
    );
    const moves = (group?.props.moves ?? []) as ToolbarMove[];
    moves.find((m) => m.label === "Mark as Read")?.run();
    expect(ran).toEqual(["read"]);
  });
});

describe("an outside card's toolbar and moves", () => {
  const head = (over: Partial<Parameters<typeof OutsideItemHeader>[0]> = {}) =>
    html(createElement(OutsideItemHeader, { facts: facts(), unread: true, flash: null, went: null, cameBack: false, thread: { kind: "loading" }, ...over }));
  const bar = (over: Partial<Parameters<typeof OutsideItemActions>[0]> = {}) =>
    html(createElement(OutsideItemActions, { facts: facts(), thread: { kind: "loading" }, typing: false, moves, picking: false, ...over }));

  test("a mail's toolbar is its subject over a grey line that says it is unread; its moves are what it is given", () => {
    const out = head();
    expect(out).toMatch(/<h2[^>]*>Your invoice</);
    expect(out).toContain('class="loki-toolbar-dot"');
    expect(out).not.toContain("loki-toolbar-item");
    expect(head({ actions: createElement("span", null, "the moves") })).toContain("the moves");
  });

  test("read is the main move on Slack and Jira, archive on a mail", () => {
    expect(outsideItem({ facts: facts({ provider: "slack", place: "#web-launch" }), messages: [], unread: true }).actions.main).toBe("mark_read");
    expect(outsideItem({ facts: facts({ provider: "jira" }), messages: [], unread: true }).actions.main).toBe("mark_read");
    expect(outsideItem({ facts: facts(), messages: [], unread: true }).actions.main).toBe("archive");
  });

  test("a mail card's moves: Hand Off, Label, Later, Mark as Read, and Archive the one prominent item", () => {
    const out = items(bar({ onHandoff: noop }));
    expect(out.map((i) => i.label)).toEqual(["Hand Off", "Label", "Later", "Mark as Read", "Archive"]);
    expect(out.filter((i) => i.prominent).map((i) => i.label)).toEqual(["Archive"]);
  });

  test("a Jira card has no Archive, and Mark as Read is its prominent item", () => {
    const out = items(bar({ facts: facts({ provider: "jira", account_id: "jira:acme", account_label: "acme.atlassian.net", subject: "WEB-412 checkout" }) }));
    expect(out.map((i) => i.label)).not.toContain("Archive");
    expect(out.filter((i) => i.prominent).map((i) => i.label)).toEqual(["Mark as Read"]);
  });

  test("a card whose account needs a sign-in shows Sign In…, and Read, Later and Archive still work", () => {
    const out = items(bar({ facts: facts({ disconnected: "sign_in_again" }), onHandoff: noop, onSignIn: noop }));
    const on = out.filter((i) => !i.off).map((i) => i.label);
    expect(on).toEqual(["Sign In…", "Later", "Mark as Read", "Archive"]);
    // Without a way to mend it there is nothing to press.
    expect(items(bar({ facts: facts({ disconnected: "sign_in_again" }) })).map((i) => i.label)).not.toContain("Sign In…");
  });

  test("a card answered elsewhere has every move off", () => {
    expect(items(bar({ off: true, onHandoff: noop })).every((i) => i.off)).toBe(true);
  });

  test("a read card has no unread dot", () => {
    expect(head({ unread: false })).not.toContain("loki-toolbar-dot");
  });
});
