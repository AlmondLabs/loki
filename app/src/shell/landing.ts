import { SHARED_SCOPE } from "../../../core/desk-core.ts";
import type { DeskSummary } from "../../../core/frame-types.ts";
import { sourceFor } from "./sidebar-model";

/**
 * Where a window lands when it opens with no chat to show (plan 2026-11-14-1300, 1), as Mail opens on the Inbox and
 * Notes on the last note, never on an empty room: Flow when something waits on the person, else the chat they were in
 * most recently, else nothing (the pane says "No Chat Selected"). Null until it can tell: the chats and the waiting
 * count have not come yet, or the window already shows a chat or another section. A chat comes with the source the
 * list shows it in: its agent's, or Pinned for a pinned chat (plan 2026-11-14-1330, R7).
 */
export type Landing = { kind: "flow" } | { kind: "chat"; scope: string; source: string } | { kind: "none" };

/** Where to land, or null when there is nothing to decide (yet). */
export function landing({
  scope,
  onChats,
  ready,
  desks,
  waiting,
}: {
  /** The chat the window holds: the shared scope is none. */
  scope: string;
  /** The window shows Chats, where the empty room would be seen. */
  onChats: boolean;
  /** The chats and Flow's cards have both come. */
  ready: boolean;
  desks: readonly DeskSummary[];
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

/** A landing as one string, "flow", "none" or "chat:<scope>", for comparing one render's with the last. */
export const landingKey = (to: Landing): string => (to.kind === "chat" ? `chat:${to.scope}` : to.kind);
