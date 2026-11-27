import { SHARED_SCOPE } from "../../../core/chat-scope.ts";
import type { ChatSummary } from "../../../core/frame-types.ts";
import { sourceFor } from "./sidebar-model";

export type Landing = { kind: "flow" } | { kind: "chat"; scope: string; source: string } | { kind: "none" };

export function landing({
  scope,
  onChats,
  ready,
  desks,
  waiting,
}: {
  scope: string;
  onChats: boolean;
  ready: boolean;
  desks: readonly ChatSummary[];
  waiting: number;
}): Landing | null {
  if (!ready || !onChats || scope !== SHARED_SCOPE) return null;
  if (waiting > 0) return { kind: "flow" };
  const recent = desks
    .filter((d) => d.status === "live" && d.scope !== SHARED_SCOPE)
    .sort((a, b) => (b.last_active ?? "").localeCompare(a.last_active ?? ""))
    .at(0);
  return recent ? { kind: "chat", scope: recent.scope, source: sourceFor(recent) } : { kind: "none" };
}

export const landingKey = (to: Landing): string => (to.kind === "chat" ? `chat:${to.scope}` : to.kind);
