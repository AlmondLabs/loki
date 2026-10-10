import type { LocalDigest, RecentFolders } from "../core/frame-types.ts";
import type { TranscriptRow } from "../core/attention/transcript.ts";
import type { LocalConversationInfo, LocalConversationRow } from "./desks.ts";

/**
 * Where the mod reads chats from (plan 017, U6): their list and details, their threads, and the folders they work in.
 * It is the daemon's own stores (daemon/chats.ts), handed to the mod as `chats` on its host. Every call answers at
 * once, as a synchronous view kept current from the stores' commits.
 */
export interface ChatSource {
  list(): LocalConversationRow[];
  info(conversationId: string, agentId?: string | null): LocalConversationInfo | null;
  /** The agent a conversation belongs to; null for an agent's main chat, whose id alone does not say. */
  agentOf(conversationId: string): string | null;
  /** The last `limit` rows of a thread, and whether older ones remain. */
  page(conversationId: string, agentId: string | null, limit: number): { rows: TranscriptRow[]; more: boolean };
  /** The thread from position `from` on (Learn's cursor), and the position to continue from. */
  since(conversationId: string, agentId: string | null, from: number): { rows: TranscriptRow[]; lines: number };
  digest(conversationId: string, agentId: string | null): LocalDigest;
  folders(): RecentFolders;
}
