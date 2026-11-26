import type { AttentionItem } from "../../../core/attention/model.ts";

export const FLOW_KINDS = ["all", "chat", "gmail", "slack", "jira"] as const;

export type FlowKind = (typeof FLOW_KINDS)[number];

export function kindOf(item: Pick<AttentionItem, "outside">): Exclude<FlowKind, "all"> {
  return item.outside?.provider ?? "chat";
}

export function inKind(item: Pick<AttentionItem, "outside">, kind: FlowKind): boolean {
  return kind === "all" || kindOf(item) === kind;
}

export function kindItems<T extends Pick<AttentionItem, "outside">>(items: readonly T[], kind: FlowKind): T[] {
  return kind === "all" ? [...items] : items.filter((i) => inKind(i, kind));
}

export function offeredKinds(items: ReadonlyArray<Pick<AttentionItem, "outside">>, chosen: FlowKind): FlowKind[] {
  const held = new Set<FlowKind>(items.map(kindOf));
  const kinds = FLOW_KINDS.filter((k) => k !== "all" && (held.has(k) || k === chosen));
  return kinds.length < 2 ? [] : ["all", ...kinds];
}
