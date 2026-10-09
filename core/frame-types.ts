import type { Scope } from "./desk-core.ts";
import type { ReasoningEffort } from "./models.ts";
import type { AskedBy } from "./attention/priority.ts";

/**
 * The shapes frames carry (core/frames.ts) that the mod produces and the app reads: desks, the Inbox's rows, the
 * board's tasks, agents and their memory and skills, folders, and the phone listener. Plain data, no behaviour; the
 * mod modules that build them import them from here.
 */

export interface LocalAgent {
  id: string;
  name: string;
  description: string | null;
  model: string | null;
  /** Provider, effort, thinking, context window… as Letta stores them. */
  modelSettings: Record<string, unknown>;
  tags: string[];
  favourite: boolean;
  /** The first line of the system prompt, for orientation; the prompt is Letta Code's, not editable here. */
  systemHead: string | null;
}

export interface MemoryFile {
  path: string;
  bytes: number;
  modifiedAt: string;
}

export interface MemorySkill {
  name: string;
  path: string;
  /** From the SKILL.md frontmatter, or its first heading. */
  description: string | null;
}

export interface MemoryCommit {
  sha: string;
  message: string;
  at: string;
  files: string[];
  /** The committer: the agent's name, or "Reflection Subagent" for a sleep-time pass (mod/reflection.ts). */
  author: string;
}

export type SkillOrigin = "self" | "other";

export type SkillSource =
  /** A git checkout on this Mac; refresh pulls it. `rel` is the skill folder inside it. */
  | { kind: "checkout"; repo: string; rel: string; label: string }
  /** A plain folder on this Mac (no git); refresh copies from it. */
  | { kind: "folder"; path: string; label: string }
  /** A GitHub repository; refresh clones it shallowly. `path` is the skill folder inside it. */
  | { kind: "github"; url: string; path: string; ref: string | null; label: string };

export interface SkillProvenance {
  origin: SkillOrigin;
  /** Commits after the last install/refresh: the agent changed its copy. */
  edited: boolean;
  /** Where refresh would fetch from; null for a self skill or an other skill nobody told us the source of. */
  source: SkillSource | null;
}

export type MemorySkillInfo = MemorySkill & SkillProvenance;

export type RefreshOutcome =
  | { outcome: "current"; label: string }
  | { outcome: "replaced"; label: string; changed: string[]; sha: string | null }
  | { outcome: "reconcile"; label: string; changed: string[]; upstreamPath: string; prompt: string };

export interface GlobalSkill {
  name: string;
  /** Where the folder really is (the link target), or the folder itself. */
  path: string;
  isLink: boolean;
  description: string | null;
  /** Where it came from, when known (mod/skill-sources.ts describeGlobal): the checkout a link points into, or the repo the `skills` CLI recorded. */
  source?: string | null;
}

export interface ReflectionConversation {
  conversationId: string;
  title: string | null;
  /** Steps since the last pass that succeeded: what the step-count trigger compares against. */
  stepsSince: number;
  totalSteps: number;
  lastStartedAt: string | null;
  lastSucceededAt: string | null;
}

export interface ReflectionState {
  /** Most steps since a pass first: the conversations nearest the next one. */
  conversations: ReflectionConversation[];
  /** The newest memory commit a reflection pass made, or null when no pass has changed memory. */
  lastCommit: MemoryCommit | null;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  labels: string[];
  assignee: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Free-form; loki uses by/agent/agentId/conversation/desk/folder and assignedTo/assignedDesk/assignedAgent. */
  metadata: Record<string, string>;
}

/** The two ways into the listener: the tailnet (a 100.x peer, or `tailscale serve` on loopback) or the Wi‑Fi. */
export type DeviceVia = "tailscale" | "lan";

/** What the inbox decides on without the app-server: who spoke last, and the assistant's last words. */
export interface LocalDigest {
  lastRole: "user" | "assistant" | null;
  lastAssistantText: string | null;
  /** Who sent the last message into the conversation: the inbox's score tells a reply to you from a cron's report by it. */
  lastAsk: AskedBy | null;
}

export interface InboxRow extends LocalDigest {
  id: string;
  agentId: string;
  agentName: string | null;
  title: string | null;
  lastMessageAt: string | null;
  archived: false;
}

export interface RecentFolders {
  /** agentId → folders, most recently used first. */
  byAgent: Record<string, string[]>;
  /** conversationDirName → folder, for the desk you are on. */
  byConversation: Record<string, string>;
}

export interface FolderCheck {
  ok: boolean;
  path: string;
  branch: string | null;
  reason?: string;
}

/** The phone listener as Settings › phone shows it (mod/lan.ts). */
export interface LanStatus {
  /** The persisted setting. `error` says whether the listener is up when this is true. */
  enabled: boolean;
  /** First non-internal IPv4 (en0 preferred), or null when the machine is off the network. */
  address: string | null;
  /** Every Wi‑Fi/Ethernet address; the tailnet's 100.x address is in `tailscale.ip`, not here. */
  addresses: string[];
  /** The Mac's Bonjour name with `.local`: what the QR and the bookmark carry, because it survives a new address on a new network. */
  host: string | null;
  port: number;
  /** A built canvas was found to serve. */
  appServed: boolean;
  /** A bind error (EADDRINUSE …) or a missing network; null when all is well. */
  error: string | null;
  /** Which route the QR encodes: the tailnet (Addendum 3) or the Wi‑Fi. Persisted when the user chose; else tailscale iff it runs. */
  via: LanVia;
  /** The tailnet's view of the Mac (mod/tailscale.ts); null when the listener was built without Tailscale. */
  tailscale: TailscaleStatus | null;
}

export type LanVia = "tailscale" | "lan";

/** The tailnet's view of the Mac (mod/tailscale.ts). */
export interface TailscaleStatus {
  /** A CLI binary was found. False → say how to install it. */
  installed: boolean;
  /** BackendState === "Running": the Mac is on the tailnet right now. */
  running: boolean;
  /** The 100.x address, or null. */
  ip: string | null;
  /** The MagicDNS name, lower-cased, no trailing dot: `my-macbook-pro.tail1234.ts.net`. */
  name: string | null;
  /** `https://<name>` when `tailscale serve` proxies 443 to the listener; else null. */
  serveUrl: string | null;
  /** The CLI's complaint (trimmed, ≤ 400 chars), or null when all is well. */
  error: string | null;
}

/** live: conversation exists. archived: Letta archived it. deleted: bound once, conversation gone. none: never bound (shared, orphan folder). */
export type DeskStatus = "live" | "archived" | "deleted" | "none";

export interface DeskInfo {
  title: string | null;
  status: DeskStatus;
  /** Which agent owns the conversation behind this desk. */
  agentName: string | null;
  agentId: string | null;
  /** The model this conversation runs on: its own override, else the agent's. */
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  /** The permission mode Letta persisted for this conversation (default: unrestricted). */
  mode?: string | null;
}

export interface DeskSummary extends DeskInfo {
  scope: Scope;
  conversationId: string | null;
  /** Pinned in Letta's pinned-conversations.json (shared with Desktop). */
  pinned?: boolean;
  widgets: number;
  active: boolean;
  lastActive: string | null;
}

/** A paired phone as the canvas sees it: never its token hash (mod/devices.ts DeviceRecord adds that). */
export interface DeviceSummary {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
  /** Which route the phone's last request came in by (mod/lan.ts requestVia); absent for a phone not seen since this field existed. */
  lastVia?: DeviceVia;
}
