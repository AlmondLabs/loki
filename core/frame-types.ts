import type { Scope } from "./desk-core.ts";
import type { ReasoningEffort } from "./models.ts";
import type { AskedBy } from "./attention/priority.ts";

/**
 * The shapes frames carry (core/frames.ts) that the mod produces and the app reads: desks, the Inbox's rows, the
 * tasks, agents and their memory and skills, folders, and the phone listener. Plain data, no behaviour; the
 * mod modules that build them import them from here.
 */

/** One agent as the Agents page shows it, read by the mod from the agent's record and sent in the `agent` frame. */
export interface LocalAgent {
  id: string;
  name: string;
  description: string | null;
  model: string | null;
  /** Provider, effort, thinking, context window… as the agent record keeps them (Letta's shape, which imported agents carry). */
  model_settings: Record<string, unknown>;
  tags: string[];
  favourite: boolean;
  /** The first line of the system prompt, for orientation; the prompt is the agent record's, not editable here. */
  system_head: string | null;
}

/** One file of an agent's memory, its path relative to the memory root with forward slashes, as the `agent` frame lists them. */
export interface MemoryFile {
  path: string;
  bytes: number;
  modified_at: string;
}

/** One skill in an agent's memory (its skills/ folder), named by its folder. */
export interface MemorySkill {
  name: string;
  path: string;
  /** From the SKILL.md frontmatter, or its first heading. */
  description: string | null;
}

/** One commit to an agent's memory repo, as the `agent` and `memory_commits` frames carry it; `at` is ISO time. */
export interface MemoryCommit {
  sha: string;
  message: string;
  at: string;
  files: string[];
  /** The committer: the agent's name, or "Reflection Subagent" for a sleep-time pass (mod/reflection.ts). */
  author: string;
}

/** Where a memory skill came from: written by the agent itself, or installed from somewhere else (mod/skill-sources.ts). */
export type SkillOrigin = "self" | "other";

/** Where refreshing an installed skill fetches it from. */
export type SkillSource =
  /** A git checkout on this Mac; refresh pulls it. `rel` is the skill folder inside it. */
  | { kind: "checkout"; repo: string; rel: string; label: string }
  /** A plain folder on this Mac (no git); refresh copies from it. */
  | { kind: "folder"; path: string; label: string }
  /** A GitHub repository; refresh clones it shallowly. `path` is the skill folder inside it. */
  | { kind: "github"; url: string; path: string; ref: string | null; label: string };

/** What the mod knows of a memory skill's origin: who wrote it, whether the agent changed its copy, and where refresh would fetch it. */
export interface SkillProvenance {
  origin: SkillOrigin;
  /** Commits after the last install/refresh: the agent changed its copy. */
  edited: boolean;
  /** Where refresh would fetch from; null for a self skill or an other skill nobody told us the source of. */
  source: SkillSource | null;
}

/** A memory skill with its provenance, as the `agent` frame lists it once the mod has read the repo's history. */
export type MemorySkillInfo = MemorySkill & SkillProvenance;

/** How refreshing an installed skill went (`skill_refreshed`): already current, replaced with upstream, or staged for the agent to reconcile with its own edits. */
export type RefreshOutcome =
  | { outcome: "current"; label: string }
  | { outcome: "replaced"; label: string; changed: string[]; sha: string | null }
  | { outcome: "reconcile"; label: string; changed: string[]; upstream_path: string; prompt: string };

/** One skill in the global skills folder (~/.agents/skills), as `skills_global` lists them. */
export interface GlobalSkill {
  name: string;
  /** Where the folder really is (the link target), or the folder itself. */
  path: string;
  is_link: boolean;
  description: string | null;
  /** Where it came from, when known (mod/skill-sources.ts describeGlobal): the checkout a link points into, or the repo the `skills` CLI recorded. */
  source?: string | null;
}

/** An agent's reflection passes as the `reflection_state` frame reports them. */
export interface ReflectionState {
  /** The newest memory commit a reflection pass made, or null when no pass has changed memory. */
  last_commit: MemoryCommit | null;
}

/** One task as the mod reads it from beads and sends it in the `tasks` frames; times are ISO, and `closedAt` is null while it is open. */
export interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  labels: string[];
  assignee: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  /** Free-form; loki uses by/agent/agent_id/conversation/desk/folder and assigned_to/assigned_desk/assigned_agent. */
  metadata: Partial<Record<string, string>>;
}

/** The two ways into the listener: the tailnet (a 100.x peer, or `tailscale serve` on loopback) or the Wi‑Fi. */
export type DeviceVia = "tailscale" | "lan";

/** What the inbox decides on, from the mod's view of each chat: who spoke last, and the assistant's last words. */
export interface LocalDigest {
  last_role: "user" | "assistant" | null;
  last_assistant_text: string | null;
  /** Who sent the last message into the conversation: the inbox's score tells a reply to you from a cron's report by it. */
  last_ask: AskedBy | null;
}

/** One open chat in the Inbox list the mod sends (`inbox`): the conversation, its agent, and its digest. Archived chats are left out. */
export interface InboxRow extends LocalDigest {
  id: string;
  agent_id: string;
  agent_name: string | null;
  title: string | null;
  last_message_at: string | null;
  archived: false;
  /** The person's labels on the chat (plan 022). */
  labels?: string[];
}

/** The folders chats have worked in lately (`folders`), for the folder picker. */
export interface RecentFolders {
  /** agentId → folders, most recently used first. */
  by_agent: Partial<Record<string, string[]>>;
  /** conversationDirName → folder, for the desk you are on. */
  by_conversation: Partial<Record<string, string>>;
}

/** Whether a path is a folder a chat can work in, and its git branch (`folder_status`, the answer to folder_check); `reason` says why not when `ok` is false. */
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
  app_served: boolean;
  /** A bind error (EADDRINUSE …) or a missing network; null when all is well. */
  error: string | null;
  /** Which route the QR encodes: the tailnet (Addendum 3) or the Wi‑Fi. Persisted when the user chose; else tailscale iff it runs. */
  via: LanVia;
  /** The tailnet's view of the Mac (mod/tailscale.ts); null when the listener was built without Tailscale. */
  tailscale: TailscaleStatus | null;
}

/** Which route the phone's QR code encodes: the tailnet or the Wi-Fi. */
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
  serve_url: string | null;
  /** The CLI's complaint (trimmed, ≤ 400 chars), or null when all is well. */
  error: string | null;
}

/** live: conversation exists. archived: the chat was archived. deleted: bound once, conversation gone. none: never bound (shared, orphan folder). */
export type DeskStatus = "live" | "archived" | "deleted" | "none";

/** What the mod knows of the conversation behind a desk: its title, status, agent and model, as the `desk` frame carries them. */
export interface DeskInfo {
  title: string | null;
  status: DeskStatus;
  /** Which agent owns the conversation behind this desk. */
  agent_name: string | null;
  agent_id: string | null;
  /** The model this conversation runs on: its own override, else the agent's. */
  model: string | null;
  reasoning_effort: ReasoningEffort | null;
  /** The permission mode the daemon keeps for this conversation (default: unrestricted). */
  mode?: string | null;
  /** The person's labels on the chat (plan 022); absent from a mod that predates them. */
  labels?: string[];
}

/** One desk in the `desks` list: its conversation's details, its scope, how many widgets it holds, and when it was last active. */
export interface DeskSummary extends DeskInfo {
  scope: Scope;
  conversation_id: string | null;
  /** Pinned in loki's pins file (mod/pins.ts). */
  pinned?: boolean;
  widgets: number;
  active: boolean;
  last_active: string | null;
}

/** A paired phone as the canvas sees it: never its token hash (mod/devices.ts DeviceRecord adds that). */
export interface DeviceSummary {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string;
  /** Which route the phone's last request came in by (mod/lan.ts requestVia); absent for a phone not seen since this field existed. */
  last_via?: DeviceVia;
}

/** One MCP tool as Settings shows it (daemon/mcp/): its hints, whether it skips search, and its definition's cost. */
export interface McpToolView {
  name: string;
  description: string;
  read_only: boolean;
  destructive: boolean;
  always_load: boolean;
  /** About how many tokens its definition costs when loaded (name, description and schema, four characters a token). */
  tokens: number;
}

/** One MCP server as Settings shows and edits it. Secrets show as the `${keychain:…}` names the file holds. */
export interface McpServerView {
  /** Safe for tool names (`mcp__<name>__…`). */
  name: string;
  /** The key as written in mcp.json, which edits name. */
  entry: string;
  kind: "local" | "remote";
  /** `signin`: a remote server waiting for an OAuth sign-in (`signIn.url`). */
  state: "starting" | "connected" | "down" | "signin";
  /** A remote server that signs in with OAuth (one with no Authorization header of its own); null for any other. */
  sign_in: { url: string | null; signed_in: boolean } | null;
  error: string | null;
  purpose: string | null;
  tools: McpToolView[];
  /** About how many tokens loading every tool would cost. */
  tokens: number;
  config: { command: string; args: string[]; env: Record<string, string>; cwd: string | null } | { url: string; headers: Record<string, string> };
  /** The agents it is switched off for. */
  off_for: string[];
}

/**
 * One ACP agent as Settings › Engines shows it (plan 020, R10): how loki starts it, and how it stands. `ready`: a
 * message went through; `started`: it starts, and sign-in shows on the first message; `not_found`: its command is
 * not on loki's PATH; `signed_out`: it said it needs signing in; `failed`: it failed for another reason; `unknown`:
 * not tried yet.
 */
export interface EngineView {
  id: string;
  name: string;
  command: string;
  args: string[];
  /** Claude Code, which loki ships; `changed` when the person's file overrides how it starts. */
  builtin: boolean;
  changed: boolean;
  status: "ready" | "started" | "not_found" | "signed_out" | "failed" | "unknown";
  detail: string | null;
}

/** Settings › Engines: the ACP agents and the file the person's own are kept in. */
export interface EnginesView {
  engines: EngineView[];
  config_path: string;
}

/** The MCP servers Settings shows (`chat_mcp`), with the problems found reading mcp.json and where that file is. */
export interface McpView {
  servers: McpServerView[];
  /** Entries in mcp.json that could not be read, one line each. */
  problems: string[];
  config_path: string;
}
