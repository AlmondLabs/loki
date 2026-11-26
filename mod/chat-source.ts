import type { Scope } from "../core/desk-core.ts";
import type { LocalDigest, RecentFolders } from "../core/frame-types.ts";
import type { TranscriptRow } from "../core/attention/transcript.ts";
import type { LocalConversationInfo, LocalConversationRow } from "./desks.ts";

export interface ChatSource {
  list(): LocalConversationRow[];
  hasScope?(scope: Scope): boolean;
  info(conversationId: string, agentId?: string | null): LocalConversationInfo | null;
  /** The agent a conversation belongs to; null for an agent's main chat, whose id alone does not say. */
  agentOf(conversationId: string): string | null;
  /** Up to `limit` rows of a thread ending before position `before` (its newest when null), where they start, and whether older ones remain. */
  page(conversationId: string, agentId: string | null, limit: number, before?: number | null): { rows: TranscriptRow[]; more: boolean; start: number };
  row(conversationId: string, agentId: string | null, row: number): TranscriptRow | null;
  ensureLoaded?(conversationId: string, agentId?: string | null): Promise<void> | void;
  /** The thread from position `from` on (Learn's cursor), and the position to continue from. */
  since(conversationId: string, agentId: string | null, from: number): { rows: TranscriptRow[]; lines: number };
  digest(conversationId: string, agentId: string | null): LocalDigest;
  folders(): RecentFolders;
}
