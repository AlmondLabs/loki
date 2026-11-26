import type { LabelView } from "../labels.ts";
import type { ConversationInfo, Digest, Live } from "./model.ts";
import type { ConnectProvider, Runtime } from "./protocol.ts";
import type { OutsideChange, ReplyProposal, Suggestion } from "../frame-types.ts";
import type { SlashCommand } from "./commands.ts";
import type { FileRef, ToolStep } from "./transcript.ts";

export type SendOrigin = "chats" | "flow" | "lesson";

export type ArchiveOrigin = "flow" | "flow_undo" | "sidebar" | "chat_header" | "phone_list" | "phone_chat";

export type OutsideCardRef = Pick<ConversationInfo, "agent_id" | "id" | "outside" | "home">;

export interface OutsideWritten {
  change: OutsideChange | null;
  error: string | null;
}

export interface HistoryPage {
  rows: Array<{
    role: "user" | "assistant" | "tool" | "event";
    text: string;
    summary?: string | null;
    detail?: string | null;
    row?: number;
    at?: string | null;
    tool?: ToolStep;
    files?: FileRef[];
  }>;
  more: boolean;
  start: number;
}

export interface ChatStoreHost {
  markSeen: (agentId: string, conversationId: string) => void;
  listConversations: () => Promise<Array<ConversationInfo & Digest> | null>;
  loadLocalHistory?: (agentId: string, conversationId: string, limit?: number, before?: number) => Promise<HistoryPage | null>;
  subscribeLimit?: number;
  engage?: (agentId: string, conversationId: string, action: "decide" | "answer") => void;
  sent?: (rt: Runtime) => void;
}

export interface SuggestionOutcome {
  done: boolean;
  message: string | null;
  suggestion: Suggestion | null;
}

export interface ReplyOutcome {
  done: boolean;
  message: string | null;
  proposal: ReplyProposal | null;
}

export interface AgentEntry {
  id: string;
  name: string;
  home_mac?: string | null;
}

export interface ChatSnapshot {
  status: "off" | "connecting" | "open" | "closed";
  server: { version: string | null; protocol: number | null; advertised: SlashCommand[]; only?: string[] } | null;
  agents: AgentEntry[];
  agentsLoaded: boolean;
  listed: boolean;
  conversations: ConversationInfo[];
  digests: Map<string, Digest>;
  live: Map<string, Live>;
  older: Partial<Record<string, true>>;
  failed: Partial<Record<string, true>>;
  providers: ConnectProvider[] | null;
  labels: LabelView[] | null;
}

export interface FolderMove {
  from: string | undefined;
  to: string;
  done: (err: string | null) => void;
}
