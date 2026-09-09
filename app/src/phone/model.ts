/**
 * The phone's pure bits — no DOM, so test/phone.test.ts can run them under bun:
 * the pairing URL both ways, the device label, the "last seen" wording, and the
 * frame shapes the mod sends about the LAN listener (the contract in
 * docs/plans/2026-09-07-007-feat-loki-mobile-plan.md, "Bridge frames").
 */

import type { LanStatus } from "../../../mod/lan.ts";
import type { DeviceSummary } from "../../../mod/devices.ts";
import { PAIRING_ALPHABET, PAIRING_LENGTH } from "../../../packages/core/src/pairing-code.ts";

/** The mod's own types: what `lan_status` and `devices` carry (mod/lan.ts, mod/devices.ts). */
export type { LanStatus };
export type PairedDevice = DeviceSummary;

/** Which way the QR sends the phone: over the tailnet, or over this Wi‑Fi (Bonjour name, else the address). */
export type LanVia = "tailscale" | "lan";

/** What `mod/tailscale.ts` found (addendum 3): the CLI, its state, the MagicDNS name, the 100.x address, an https front. */
export interface TailscaleStatus {
  installed: boolean;
  running: boolean;
  /** The 100.x address, when running. */
  ip: string | null;
  /** The MagicDNS name without its trailing dot, e.g. my-macbook-pro.tail1234.ts.net. */
  name: string | null;
  /** `https://<name>` while `tailscale serve` fronts the listener; null when it does not. */
  serveUrl: string | null;
  /** The CLI's own words when `tailscale serve` failed; null when all is well. */
  error: string | null;
}

/**
 * `lan_status` as the canvas reads it: the mod's LanStatus plus the route fields from addendum 3.
 * Structural on purpose, so the canvas and the mod can land in either order; `lanStatusFromFrame`
 * fills the new fields with "not on this Mac" when a mod does not send them yet.
 */
export type PhoneLanStatus = LanStatus & { via: LanVia; tailscale: TailscaleStatus | null };

/** The `lan_status` frame, read defensively: a field of the wrong shape becomes its quiet default. */
export function lanStatusFromFrame(msg: Record<string, unknown>): PhoneLanStatus {
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const t = msg.tailscale;
  let tailscale: TailscaleStatus | null = null;
  if (t && typeof t === "object") {
    const o = t as Record<string, unknown>;
    tailscale = { installed: o.installed === true, running: o.running === true, ip: str(o.ip), name: str(o.name), serveUrl: str(o.serveUrl), error: str(o.error) };
  }
  return {
    enabled: msg.enabled === true,
    address: str(msg.address),
    addresses: Array.isArray(msg.addresses) ? (msg.addresses as unknown[]).filter((a): a is string => typeof a === "string") : [],
    host: str(msg.host),
    port: typeof msg.port === "number" ? msg.port : 41415,
    appServed: msg.appServed === true,
    error: str(msg.error),
    // The tailnet is a route only while it runs; an older mod sends neither field and the QR carries the Wi‑Fi.
    via: msg.via === "tailscale" && tailscale?.running ? "tailscale" : "lan",
    tailscale,
  };
}

/**
 * The origin the next pairing QR will carry, in the mod's order (`pairUrl`): the https front, the
 * tailnet name, the Bonjour name, the address. Null when there is nothing to reach the Mac by.
 */
export function pairOrigin(s: PhoneLanStatus): string | null {
  const ts = s.tailscale;
  if (s.via === "tailscale" && ts?.running) {
    if (ts.serveUrl) return ts.serveUrl;
    if (ts.name) return `http://${ts.name}:${s.port}`;
    if (ts.ip) return `http://${ts.ip}:${s.port}`;
  }
  const h = s.host ?? s.address;
  return h ? `http://${h}:${s.port}` : null;
}

/**
 * How this phone reaches the Mac, read off the page's own `location`: a `.ts.net` host is the
 * tailnet, `.local` is Bonjour on this Wi‑Fi, a bare address is this Wi‑Fi too; anything else is
 * named as it is. `https:` is worth a word because it means `tailscale serve` is in front.
 */
export function routeOf(host: string, protocol: string): string {
  const hostname = host.replace(/^\[([^\]]+)\](?::\d+)?$/, "$1").replace(/^([^:]+):\d+$/, "$1").toLowerCase();
  const secure = protocol === "https:" ? " · https" : "";
  if (hostname.endsWith(".ts.net")) return `via Tailscale${secure}`;
  if (hostname.endsWith(".local")) return `via this Wi‑Fi (Bonjour)${secure}`;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":")) return `via this Wi‑Fi (address)${secure}`;
  return hostname ? `via ${hostname}${secure}` : "unknown";
}

/**
 * The address a phone uses on this Wi‑Fi, as Settings › route prints it: the Bonjour name with the
 * port, then the raw address after a dot; the raw address alone when there is no name; a note on the
 * port when there is no network at all.
 */
export function wifiAddress(s: PhoneLanStatus): string {
  return s.host ? `${s.host}:${s.port}${s.address ? ` · ${s.address}` : ""}` : s.address ? `${s.address}:${s.port}` : `port ${s.port}, no network`;
}

/**
 * The address a phone uses over the tailnet, in the mod's order: the https front (scheme dropped, marked
 * `· https`), the MagicDNS name with the port, the tailnet IP with the port. Null with no Tailscale status.
 */
export function tailnetAddress(s: PhoneLanStatus): string | null {
  const ts = s.tailscale;
  return ts?.serveUrl ? ts.serveUrl.replace(/^https:\/\//, "") + " · https" : ts?.name ? `${ts.name}:${s.port}` : ts?.ip ? `${ts.ip}:${s.port}` : null;
}

/** A fresh pairing code (`pair_code`). */
export interface PairCode {
  code: string;
  /** The URL the mod built when it minted the code; Settings prefers pairUrlFor(), which follows the route as it changes. */
  url: string;
  /** ISO time after which the code is refused. */
  expiresAt: string;
}

/**
 * The URL the QR should carry now: the current route's origin plus the code. The mod's `pair_code.url`
 * was built once, at minting; if the route is switched while the code lives, the QR must follow, or the
 * pill says Tailscale while the phone is sent to the Wi‑Fi. Null when nothing can reach the Mac.
 */
export function pairUrlFor(s: PhoneLanStatus, code: string): string | null {
  const origin = pairOrigin(s);
  return origin ? `${origin}/?code=${encodeURIComponent(code)}` : null;
}

/** "Tailscale" or "Wi‑Fi": the word next to a phone for the route its last request used; null when the mod has not seen it since routes were recorded. */
export function viaLabel(via: unknown): string | null {
  return via === "tailscale" ? "Tailscale" : via === "lan" ? "Wi‑Fi" : null;
}

/** The pairing alphabet and length are the mod's (mod/pairing.ts); the URL itself comes from the mod in `pair_code`. */
export const CODE_ALPHABET = PAIRING_ALPHABET;
export const CODE_LENGTH = PAIRING_LENGTH;

/** The code in a pairing URL or a bare query string, normalised; null when there is none. */
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

/** Uppercase, alphabet only, at most six characters — what the code field keeps as you type. */
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

/** "iPhone · 14:05": the label a paired phone gets in Settings, so two of the same kind stay apart. */
export function deviceName(ua: string, now: Date = new Date(), touchPoints = 0): string {
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${deviceKind(ua, touchPoints)} · ${hh}:${mm}`;
}

/** "just now", "1 minute ago", "3 hours ago", "2 days ago" — for a device's last visit and the Mac's last answer. */
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

/** An agent's name: the app-server's list first, then any desk of its; null when neither knows it. */
export function agentNameOf(agents: Array<{ id: string; name: string }>, desks: Array<{ agentId: string | null; agentName: string | null }>, id: string): string | null {
  return agents.find((a) => a.id === id)?.name ?? desks.find((d) => d.agentId === id)?.agentName ?? null;
}

/**
 * The conversation on screen, named: its title and agent come from the desks list first, then the
 * inbox item, then the agent list; the main chat is "<agent> · main chat" when nothing else names it.
 */
export function threadFor(
  conv: { agentId: string; conversationId: string },
  desks: Array<{ agentId: string | null; conversationId: string | null; title: string | null; agentName: string | null }>,
  items: Array<{ agentId: string; id: string; title: string | null; agentName: string | null }>,
  agents: Array<{ id: string; name: string }>,
): { agentId: string; conversationId: string; title: string | null; agentName: string | null } {
  const convDesk = desks.find((d) => d.agentId === conv.agentId && d.conversationId === conv.conversationId);
  const convItem = items.find((i) => i.agentId === conv.agentId && i.id === conv.conversationId);
  return {
    agentId: conv.agentId,
    conversationId: conv.conversationId,
    title: convDesk?.title ?? convItem?.title ?? (conv.conversationId === "default" ? `${agentNameOf(agents, desks, conv.agentId) ?? "agent"} · main chat` : null),
    agentName: convDesk?.agentName ?? convItem?.agentName ?? agentNameOf(agents, desks, conv.agentId),
  };
}

/**
 * The card footer's first word: for a card waiting on you (an approval, or a question — structured or the
 * last message read as one) how long it has waited; otherwise how long since the last message.
 */
export function waitingSince(item: { status: string; lastMessageAt: string | null; pendingApproval: { at: string | null } | null; pendingQuestion: { at: string } | null }, now: number = Date.now()): string {
  const at = item.status === "approval" ? (item.pendingApproval?.at ?? item.lastMessageAt) : item.pendingQuestion ? item.pendingQuestion.at : item.lastMessageAt;
  const since = lastSeen(at, now);
  const asks = !!item.pendingQuestion || item.status === "question";
  const blocked = !!item.pendingApproval || asks;
  return blocked ? (since === "just now" ? "waiting under a minute" : `waiting ${since.replace(" ago", "")}`) : since;
}

/** How many live desks an agent has — the "n desks live" under its row. */
export function liveDeskCount(desks: Array<{ agentId: string | null; status: string }>, agentId: string): number {
  return desks.filter((d) => d.agentId === agentId && d.status === "live").length;
}

/** "3 desks live", "1 desk live", "no desks live". */
export function liveDesksLabel(n: number): string {
  return n === 0 ? "no desks live" : `${n} desk${n === 1 ? "" : "s"} live`;
}

/**
 * The model line under an agent's name: the model, then whatever of effort, thinking and the context
 * window the harness set; empty when it runs on the harness default.
 */
export function modelBits(model: string | null | undefined, settings: Record<string, unknown>): string[] {
  return [model ?? null, settings.effort ? `effort ${String(settings.effort)}` : null, settings.thinking ? "thinking" : null, settings.context_window_limit ? `${Math.round(Number(settings.context_window_limit) / 1000)}k context` : null].filter(Boolean) as string[];
}

export interface MemoryFolder {
  /** "" for files at the root. */
  name: string;
  files: Array<{ path: string; name: string; bytes: number; modifiedAt: string }>;
}

/**
 * The memory tree the way the desktop groups it: by first folder, `system` first, the root's files
 * last; skills and the face are the agent's other views and stay out. `name` is the path inside the folder.
 */
export function memoryFolders(files: Array<{ path: string; bytes: number; modifiedAt: string }>): MemoryFolder[] {
  const m = new Map<string, MemoryFolder>();
  for (const f of files) {
    if (f.path.startsWith("skills/") || f.path === "profile.png") continue;
    const i = f.path.indexOf("/");
    const g = i >= 0 ? f.path.slice(0, i) : "";
    if (!m.has(g)) m.set(g, { name: g, files: [] });
    m.get(g)!.files.push({ path: f.path, name: g ? f.path.slice(g.length + 1) : f.path, bytes: f.bytes, modifiedAt: f.modifiedAt });
  }
  const rank = (g: string) => (g === "system" ? 0 : g === "" ? 2 : 1);
  return [...m.values()].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

/**
 * A memory file's YAML frontmatter (`---` … `---` at the very top) is metadata for the agent, not
 * reading: markdown would draw its first line as a heading over a rule. The phone shows the body.
 */
export function stripFrontmatter(md: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(md);
  return m ? md.slice(m[0].length) : md;
}

/**
 * The Mac serves a newer canvas than the one this page loaded: `served` is what /health or the mod's
 * `app_build` frame says, `current` what index.html injected as `__LOKI__.build`. Unknown on either
 * side means nothing to compare.
 */
export function needsReload(served: string | null | undefined, current: string | null | undefined): boolean {
  return !!served && !!current && served !== current;
}

/** Hidden for longer than this and back to a changed build: reload without asking — nothing is mid-flight. */
export const AUTO_RELOAD_HIDDEN_MS = 30_000;

export function shouldAutoReload(hiddenMs: number, changed: boolean): boolean {
  return changed && Number.isFinite(hiddenMs) && hiddenMs > AUTO_RELOAD_HIDDEN_MS;
}

/** "9:58" until `iso`, or "expired". */
export function countdown(iso: string, now: number = Date.now()): string {
  const s = Math.floor((new Date(iso).getTime() - now) / 1000);
  if (!Number.isFinite(s) || s <= 0) return "expired";
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
