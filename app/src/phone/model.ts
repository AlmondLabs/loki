import { PAIRING_ALPHABET, PAIRING_LENGTH } from "../../../core/pairing-code.ts";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { catchUpQueue } from "../../../core/attention/queue.ts";
import { labelQuery } from "../../../core/labels.ts";

import { archivedDesks, liveDesks } from "../shell/desk-tree";
import { sidebarModel, type SidebarSection } from "../shell/sidebar-model";
import type { ThemePreference } from "../theme";
import type { IconName } from "./icons";
import type { Route } from "./router";
import type { DeskSummary, DeviceSummary, LanStatus, LanVia, TailscaleStatus } from "../../../core/frame-types.ts";

export type PairedDevice = DeviceSummary;

export type PhoneLanStatus = LanStatus & { via: LanVia; tailscale: TailscaleStatus | null };

export function lanStatusFromFrame(msg: Record<string, unknown>): PhoneLanStatus {
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const t = msg.tailscale;
  let tailscale: TailscaleStatus | null = null;
  if (t && typeof t === "object") {
    const o = t as Record<string, unknown>;
    tailscale = {
      installed: o.installed === true,
      running: o.running === true,
      ip: str(o.ip),
      name: str(o.name),
      serve_url: str(o.serve_url),
      error: str(o.error),
    };
  }
  return {
    enabled: msg.enabled === true,
    address: str(msg.address),
    addresses: Array.isArray(msg.addresses) ? (msg.addresses as unknown[]).filter((a): a is string => typeof a === "string") : [],
    host: str(msg.host),
    port: typeof msg.port === "number" ? msg.port : 41415,
    app_served: msg.app_served === true,
    error: str(msg.error),
    via: msg.via === "tailscale" && tailscale?.running ? "tailscale" : "lan",
    tailscale,
  };
}

export function pairOrigin(s: PhoneLanStatus): string | null {
  const ts = s.tailscale;
  if (s.via === "tailscale" && ts?.running) {
    if (ts.serve_url) return ts.serve_url;
    if (ts.name) return `http://${ts.name}:${s.port}`;
    if (ts.ip) return `http://${ts.ip}:${s.port}`;
  }
  const h = s.host ?? s.address;
  return h ? `http://${h}:${s.port}` : null;
}

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

export function wifiAddress(s: PhoneLanStatus): string {
  return s.host ? `${s.host}:${s.port}${s.address ? ` · ${s.address}` : ""}` : s.address ? `${s.address}:${s.port}` : `port ${s.port}, no network`;
}

export function tailnetAddress(s: PhoneLanStatus): string | null {
  const ts = s.tailscale;
  return ts?.serve_url ? ts.serve_url.replace(/^https:\/\//, "") + " · https" : ts?.name ? `${ts.name}:${s.port}` : ts?.ip ? `${ts.ip}:${s.port}` : null;
}

export interface PairCode {
  code: string;
  url: string;
  expiresAt: string;
}

export function pairUrlFor(s: PhoneLanStatus, code: string): string | null {
  const origin = pairOrigin(s);
  return origin ? `${origin}/?code=${encodeURIComponent(code)}` : null;
}

export function viaLabel(via: unknown): string | null {
  return via === "tailscale" ? "Tailscale" : via === "lan" ? "Wi‑Fi" : null;
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

export function lastSeen(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"} ago`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return unit(hours, "hour");
  return unit(Math.floor(hours / 24), "day");
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
      convDesk?.title ?? convItem?.title ?? (conv.conversationId === "default" ? `${agentNameOf(agents, desks, conv.agentId) ?? "agent"} · main chat` : null),
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

export function liveDeskCount(desks: Array<{ agent_id: string | null; status: string }>, agentId: string): number {
  return desks.filter((d) => d.agent_id === agentId && d.status === "live").length;
}

export function liveDesksLabel(n: number): string {
  return n === 0 ? "No chats live" : `${n} chat${n === 1 ? "" : "s"} live`;
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

export function stripFrontmatter(md: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(md);
  return m ? md.slice(m[0].length) : md;
}

export function needsReload(served: string | null | undefined, current: string | null | undefined): boolean {
  return !!served && !!current && served !== current;
}

export const AUTO_RELOAD_HIDDEN_MS = 30_000;

export function shouldAutoReload(hiddenMs: number, changed: boolean, drafting = false): boolean {
  return changed && !drafting && Number.isFinite(hiddenMs) && hiddenMs > AUTO_RELOAD_HIDDEN_MS;
}

export function countdown(iso: string, now: number = Date.now()): string {
  const s = Math.floor((new Date(iso).getTime() - now) / 1000);
  if (!Number.isFinite(s) || s <= 0) return "expired";
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const HOME_ATTENTION_MAX = 5;

const norm = (q: string) => q.trim().toLowerCase();

export function archiveList(desks: DeskSummary[], agentFilter: string | null, q: string): DeskSummary[] {
  return archivedDesks(desks, agentFilter, norm(q)).filter((d) => d.agent_id && d.conversation_id);
}

export interface HomeCounts {
  inbox: number;
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
  desks: DeskSummary[];
}): HomeCounts {
  return {
    inbox: catchUpQueue(laneItems).length,
    learn: due,
    agents: agents.length,
    running: new Set(items.filter((i) => i.status === "running").map((i) => i.agent_id)).size,
    archive: archiveList(desks, null, "").length,
  };
}

export type Shortcut = "inbox" | "learn" | "agents" | "archive";

export function shortcutLine(kind: Shortcut, c: HomeCounts): string {
  const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
  if (kind === "inbox") return c.inbox ? `${c.inbox} waiting` : "All caught up";
  if (kind === "learn") return c.learn ? `${c.learn} due` : "Nothing due";
  if (kind === "agents") return c.running ? `${c.running} running` : n(c.agents, "agent");
  return c.archive ? n(c.archive, "chat") : "None yet";
}

export function homeDeskSections(
  desks: DeskSummary[],
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
  desks: DeskSummary[];
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
    groups: homeDeskSections(desks, items, attention, query, agents),
  };
}

export interface HomeAttention {
  item: AttentionItem;
  desk: DeskSummary | undefined;
  opens: "chat" | "card";
}

export function homeSections(
  desks: DeskSummary[],
  items: AttentionItem[],
  agentFilter: string | null,
  query: string,
  max = HOME_ATTENTION_MAX,
): { attention: HomeAttention[]; more: number; desks: DeskSummary[] } {
  const { labels, text } = labelQuery(query);
  const q = norm(text);
  const byKey = new Map<string, DeskSummary>();
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

export interface AgentRowModel {
  id: string;
  name: string;
  live: number;
  running: boolean;
  waiting: number;
}

export function agentRows(
  agents: Array<{ id: string; name: string }>,
  desks: Array<{ agent_id: string | null; status: string }>,
  items: AttentionItem[],
): AgentRowModel[] {
  const ready = catchUpQueue(items);
  return agents.map((a) => ({
    id: a.id,
    name: a.name,
    live: liveDeskCount(desks, a.id),
    running: items.some((i) => i.agent_id === a.id && i.status === "running"),
    waiting: ready.filter((i) => i.agent_id === a.id).length,
  }));
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

export function deskName(d: DeskSummary): string {
  return d.title ?? (d.status === "live" ? "New chat" : d.scope);
}
