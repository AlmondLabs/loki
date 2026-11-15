import type { AttentionItem } from "../../../core/attention/model.ts";

/** Flow's kinds (plan 2026-11-15-1740), in the pills' order: every card, then a chat, a mail, a Slack thread, a ticket. */
export const FLOW_KINDS = ["all", "chat", "gmail", "slack", "jira"] as const;

/** One of Flow's kinds; "all" is every card. */
export type FlowKind = (typeof FLOW_KINDS)[number];

/** A card's kind: its outside account's provider, or a chat when it is one of loki's own. */
export function kindOf(item: Pick<AttentionItem, "outside">): Exclude<FlowKind, "all"> {
  return item.outside?.provider ?? "chat";
}

/** Whether `kind` holds the card. */
export function inKind(item: Pick<AttentionItem, "outside">, kind: FlowKind): boolean {
  return kind === "all" || kindOf(item) === kind;
}

/** The cards `kind` holds, in their order. */
export function kindItems<T extends Pick<AttentionItem, "outside">>(items: readonly T[], kind: FlowKind): T[] {
  return kind === "all" ? [...items] : items.filter((i) => inKind(i, kind));
}

/**
 * The kinds the pills offer (R1): All, then each kind Flow holds a card of, in any lane, and the chosen kind while it
 * is chosen, so its pill does not vanish under the person as they clear it. With fewer than two kinds a pill could only
 * show what the list already does, so there are none.
 */
export function offeredKinds(items: ReadonlyArray<Pick<AttentionItem, "outside">>, chosen: FlowKind): FlowKind[] {
  const held = new Set<FlowKind>(items.map(kindOf));
  const kinds = FLOW_KINDS.filter((k) => k !== "all" && (held.has(k) || k === chosen));
  return kinds.length < 2 ? [] : ["all", ...kinds];
}
