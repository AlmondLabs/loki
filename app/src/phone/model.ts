import { PAIRING_ALPHABET, PAIRING_LENGTH } from "../../../core/pairing-code.ts";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { catchUpQueue } from "../../../core/attention/queue.ts";
import { labelQuery } from "../../../core/labels.ts";

import { archivedDesks, liveDesks } from "../shell/chat-tree";
import { sidebarModel, type SidebarSection } from "../shell/sidebar-model";
import type { ThemePreference } from "../theme";
import type { IconName } from "./icons";
import type { Route } from "./router";
import type { ChatSummary } from "../../../core/frame-types.ts";
import { isMainChat } from "../../../core/canvas-core.ts";
import { isAdvisorChat } from "../../../core/advisor.ts";
import { lastSeen } from "../shared/lan-model";
import { liveDesksLabel, type AgentRowModel } from "../shared/agent-model";

export {
  countdown,
  lanStatusFromFrame,
  lastSeen,
  pairOrigin,
  pairUrlFor,
  tailnetAddress,
  viaLabel,
  wifiAddress,
  type PairCode,
  type PairedDevice,
  type PhoneLanStatus,
} from "../shared/lan-model";
export { agentRows, liveDeskCount, liveDesksLabel, stripFrontmatter, type AgentRowModel } from "../shared/agent-model";

export function routeOf(host: string, protocol: string): string {
  const hostname = host
    .replace(/^\[([^\]]+)\](?::\d+)?$/, "$1")
    .replace(/^([^:]+):\d+$/, "$1")
    .toLowerCase();
  const secure = protocol === "https:" ? " · https" : "";
  if (hostname.endsWith(".ts.net")) return `via Tailscale${secure}`;
  if (hostname.endsWith(".local")) return `via this Wi‑Fi (Bonjour)${secure}`;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":")) return `via this Wi‑Fi (address)${secure}`;
  return hostname ? `via ${hostname}${secure}` : "unknown";
}

export const CODE_ALPHABET = PAIRING_ALPHABET;
export const CODE_LENGTH = PAIRING_LENGTH;

export function codeFromUrl(url: string): string | null {
  try {
    const search = url.startsWith("?") ? url : new URL(url, "http://localhost").search;
    const raw = new URLSearchParams(search).get("code");
    if (!raw) return null;
    const code = normalizeCode(raw);
    return code.length === CODE_LENGTH ? code : null;
  } catch {
    return null;
  }
}

export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .split("")
    .filter((c) => CODE_ALPHABET.includes(c))
    .join("")
    .slice(0, CODE_LENGTH);
}

export type DeviceKind = "iPhone" | "iPad" | "Android" | "phone";

/**
 * What kind of device a user agent is. iPadOS Safari calls itself a Macintosh, so a Mac UA with
 * touch points is an iPad; the caller passes `navigator.maxTouchPoints` when it has one.
 */
export function deviceKind(ua: string, touchPoints = 0): DeviceKind {
  if (/iPad/i.test(ua)) return "iPad";
  if (/iPhone|iPod/i.test(ua)) return "iPhone";
  if (/Android/i.test(ua)) return "Android";
  if (/Macintosh/i.test(ua) && touchPoints > 1) return "iPad";
  return "phone";
}

export function deviceName(ua: string, now: Date = new Date(), touchPoints = 0): string {
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${deviceKind(ua, touchPoints)} · ${hh}:${mm}`;
}

export function agentNameOf(
  agents: Array<{ id: string; name: string }>,
  desks: Array<{ agent_id: string | null; agent_name: string | null }>,
  id: string,
): string | null {
  return agents.find((a) => a.id === id)?.name ?? desks.find((d) => d.agent_id === id)?.agent_name ?? null;
}

export function threadFor(
  conv: { agentId: string; conversationId: string },
  desks: Array<{ agent_id: string | null; conversation_id: string | null; title: string | null; agent_name: string | null }>,
  items: Array<{ agent_id: string; id: string; title: string | null; agent_name: string | null }>,
  agents: Array<{ id: string; name: string }>,
): { agentId: string; conversationId: string; title: string | null; agentName: string | null } {
  const convDesk = desks.find((d) => d.agent_id === conv.agentId && d.conversation_id === conv.conversationId);
  const convItem = items.find((i) => i.agent_id === conv.agentId && i.id === conv.conversationId);
  return {
    agentId: conv.agentId,
    conversationId: conv.conversationId,
    title:
      convDesk?.title ??
      convItem?.title ??
      (isMainChat(conv.conversationId)
        ? `${agentNameOf(agents, desks, conv.agentId) ?? "agent"} · main chat`
        : isAdvisorChat(conv.conversationId)
          ? "Advisor"
          : null),
    agentName: convDesk?.agent_name ?? convItem?.agent_name ?? agentNameOf(agents, desks, conv.agentId),
  };
}

export function waitingSince(
  item: { status: string; last_message_at: string | null; pendingApproval: { at: string | null } | null; pendingQuestion: { at: string } | null },
  now: number = Date.now(),
): string {
  const at =
    item.status === "approval" ? (item.pendingApproval?.at ?? item.last_message_at) : item.pendingQuestion ? item.pendingQuestion.at : item.last_message_at;
  const since = lastSeen(at, now);
  const asks = !!item.pendingQuestion || item.status === "question";
  const blocked = !!item.pendingApproval || asks;
  return blocked ? (since === "just now" ? "Waiting under a minute" : `Waiting ${since.replace(" ago", "")}`) : since;
}

export function modelBits(model: string | null | undefined, settings: Record<string, unknown>): string[] {
  return [
    model ?? null,
    typeof settings.reasoning_effort === "string" ? `effort ${settings.reasoning_effort}` : null,
    settings.context_window_limit ? `${Math.round(Number(settings.context_window_limit) / 1000)}k context` : null,
  ].filter(Boolean) as string[];
}

export interface MemoryFolder {
  name: string;
  files: Array<{ path: string; name: string; bytes: number; modifiedAt: string }>;
}

export function memoryFolders(files: Array<{ path: string; bytes: number; modified_at: string }>): MemoryFolder[] {
  const m = new Map<string, MemoryFolder>();
  for (const f of files) {
    if (f.path.startsWith("skills/") || f.path === "profile.png") continue;
    const i = f.path.indexOf("/");
    const g = i >= 0 ? f.path.slice(0, i) : "";
    let group = m.get(g);
    if (!group) {
      group = { name: g, files: [] };
      m.set(g, group);
    }
    group.files.push({ path: f.path, name: g ? f.path.slice(g.length + 1) : f.path, bytes: f.bytes, modifiedAt: f.modified_at });
  }
  const rank = (g: string) => (g === "system" ? 0 : g === "" ? 2 : 1);
  return [...m.values()].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

export function needsReload(served: string | null | undefined, current: string | null | undefined): boolean {
  return !!served && !!current && served !== current;
}

export const AUTO_RELOAD_HIDDEN_MS = 30_000;

export function shouldAutoReload(hiddenMs: number, changed: boolean, drafting = false): boolean {
  return changed && !drafting && Number.isFinite(hiddenMs) && hiddenMs > AUTO_RELOAD_HIDDEN_MS;
}

export const HOME_ATTENTION_MAX = 5;

const norm = (q: string) => q.trim().toLowerCase();

export function archiveList(desks: ChatSummary[], agentFilter: string | null, q: string): ChatSummary[] {
  return archivedDesks(desks, agentFilter, norm(q)).filter((d) => d.agent_id && d.conversation_id);
}

export interface HomeCounts {
  flow: number;
  learn: number;
  agents: number;
  running: number;
  archive: number;
}

export function homeCounts({
  items,
  laneItems = items,
  due,
  agents,
  desks,
}: {
  items: AttentionItem[];
  laneItems?: AttentionItem[];
  due: number;
  agents: Array<{ id: string }>;
  desks: ChatSummary[];
}): HomeCounts {
  return {
    flow: catchUpQueue(laneItems).length,
    learn: due,
    agents: agents.length,
    running: new Set(items.filter((i) => i.status === "running").map((i) => i.agent_id)).size,
    archive: archiveList(desks, null, "").length,
  };
}

export type Shortcut = "flow" | "learn" | "agents" | "archive";

export function shortcutLine(kind: Shortcut, c: HomeCounts): string {
  const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
  if (kind === "flow") return c.flow ? `${c.flow} waiting` : "All caught up";
  if (kind === "learn") return c.learn ? `${c.learn} due` : "Nothing due";
  if (kind === "agents") return c.running ? `${c.running} running` : n(c.agents, "agent");
  return c.archive ? n(c.archive, "chat") : "None yet";
}

export function homeChatSections(
  desks: ChatSummary[],
  items: AttentionItem[],
  attention: HomeAttention[],
  query: string,
  agents: Array<{ id: string; name: string | null }>,
): SidebarSection[] {
  const above = new Set(attention.map((a) => `${a.item.agent_id}/${a.item.id}`));
  const named = agents.flatMap((a) => (a.name ? [{ id: a.id, name: a.name }] : []));
  return sidebarModel(desks, items, { query, agents: named })
    .sections.map((sec) => {
      const rows = sec.rows.filter((r) => !above.has(`${r.desk.agent_id}/${r.desk.conversation_id}`));
      return { ...sec, rows, waiting: rows.filter((r) => r.kind === "waits").length };
    })
    .filter((sec) => sec.rows.length > 0);
}

export function homeLists({
  desks,
  items,
  laneItems,
  query,
  agents,
  due,
}: {
  desks: ChatSummary[];
  items: AttentionItem[];
  laneItems: AttentionItem[];
  query: string;
  agents: Array<{ id: string; name: string | null }>;
  due: number;
}): { counts: HomeCounts; attention: HomeAttention[]; more: number; groups: SidebarSection[] } {
  const { attention, more } = homeSections(desks, laneItems, null, query);
  return {
    counts: homeCounts({ items, laneItems, due, agents, desks }),
    attention,
    more,
    groups: homeChatSections(desks, items, attention, query, agents),
  };
}

export interface HomeAttention {
  item: AttentionItem;
  desk: ChatSummary | undefined;
  opens: "chat" | "card";
}

export function homeSections(
  desks: ChatSummary[],
  items: AttentionItem[],
  agentFilter: string | null,
  query: string,
  max = HOME_ATTENTION_MAX,
): { attention: HomeAttention[]; more: number; desks: ChatSummary[] } {
  const { labels, text } = labelQuery(query);
  const q = norm(text);
  const byKey = new Map<string, ChatSummary>();
  for (const d of desks) if (d.agent_id && d.conversation_id) byKey.set(`${d.agent_id}/${d.conversation_id}`, d);
  const waiting = catchUpQueue(items)
    .map((item): HomeAttention => ({ item, desk: byKey.get(`${item.agent_id}/${item.id}`), opens: item.outside ? "card" : "chat" }))
    .filter(
      ({ item, desk }) =>
        (!agentFilter || item.agent_id === agentFilter) &&
        labels.every((l) => (item.labels ?? desk?.labels ?? []).includes(l)) &&
        (!q || [desk?.title, item.title, item.agent_name ?? desk?.agent_name].some((s) => (s ?? "").toLowerCase().includes(q))),
    );
  const attention = waiting.slice(0, max);
  const shown = new Set(attention.map(({ item }) => `${item.agent_id}/${item.id}`));
  return {
    attention,
    more: waiting.length - attention.length,
    desks: liveDesks(desks, agentFilter, q).filter((d) => !shown.has(`${d.agent_id}/${d.conversation_id}`)),
  };
}

export type LinkState = "online" | "connecting" | "offline";

export function linkState(mod: "connecting" | "open" | "closed"): LinkState {
  return mod === "open" ? "online" : mod === "closed" ? "offline" : "connecting";
}

export function threadLine({
  status,
  approval,
  question,
  waiting,
  desk,
}: {
  status: "idle" | "thinking" | "streaming";
  approval: unknown;
  question: unknown;
  waiting: boolean;
  desk: string | null;
}): string {
  const live = approval
    ? "Needs approval"
    : question
      ? "Asked you"
      : status === "streaming"
        ? "Writing"
        : status === "thinking"
          ? "Working"
          : waiting
            ? "Waiting on you"
            : null;
  return [live, desk].filter(Boolean).join(" · ");
}

export type AgentFilter = "all" | "running" | "waiting";
export const AGENT_FILTERS: ReadonlyArray<{ id: AgentFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "waiting", label: "Waiting on you" },
];

export function agentsShown(rows: AgentRowModel[], filter: AgentFilter): AgentRowModel[] {
  if (filter === "running") return rows.filter((r) => r.running);
  if (filter === "waiting") return rows.filter((r) => r.waiting > 0);
  return rows;
}

export function agentLine(r: AgentRowModel, description: string | null | undefined): string {
  return [r.waiting ? `${r.waiting} waiting` : null, r.running ? "Working" : null, description || liveDesksLabel(r.live)].filter(Boolean).join(" · ");
}

export function linkWord(link: LinkState): string {
  return link === "online" ? "Online" : link === "connecting" ? "Connecting" : "Unreachable";
}

export type UpdateState = "ready" | "current" | "unknown";
export function updateState(served: string | null | undefined, current: string | null | undefined): UpdateState {
  if (!current) return "unknown";
  return needsReload(served, current) ? "ready" : "current";
}

export const PHONE_APPEARANCE: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export type MoreRowId = "mac" | "agents" | "learn" | "archive" | "preferences" | "usage" | "updates" | "about" | "connection";
export interface MoreRow {
  id: MoreRowId;
  icon: IconName;
  label: string;
  aside: string | null;
  to: Route | null;
}

export function moreSections(s: {
  link: LinkState;
  agents: number;
  running: number;
  due: number;
  archived: number;
  appearance: string;
  update: UpdateState;
}): Array<{ label: string; rows: MoreRow[] }> {
  return [
    { label: "Paired Mac", rows: [{ id: "mac", icon: "laptop", label: "Paired Mac", aside: linkWord(s.link), to: { kind: "connection" } }] },
    {
      label: "Places",
      rows: [
        {
          id: "agents",
          icon: "agents",
          label: "Agents",
          aside: s.running ? `${s.running} running` : s.agents ? String(s.agents) : null,
          to: { kind: "tab", tab: "agents" },
        },
        { id: "learn", icon: "learn", label: "Learn", aside: s.due ? `${s.due} due` : null, to: { kind: "learn" } },
        { id: "archive", icon: "archive", label: "Archived chats", aside: s.archived ? String(s.archived) : null, to: { kind: "archive" } },
        { id: "preferences", icon: "settings", label: "Preferences", aside: s.appearance, to: { kind: "preferences" } },
        { id: "usage", icon: "history", label: "Usage", aside: null, to: { kind: "usage" } },
      ],
    },
    {
      label: "loki",
      rows: [
        {
          id: "updates",
          icon: "refresh",
          label: "Updates",
          aside: s.update === "ready" ? "Update ready" : s.update === "current" ? "Up to date" : null,
          to: null,
        },
        { id: "about", icon: "info", label: "About loki", aside: null, to: { kind: "about" } },
        { id: "connection", icon: "link", label: "Connection details", aside: null, to: { kind: "connection" } },
      ],
    },
  ];
}

export function chatTitle(d: ChatSummary): string {
  return d.title ?? (d.status === "live" ? "New chat" : d.scope);
}
