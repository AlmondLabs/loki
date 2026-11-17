export type LinkDirection = "one_way" | "both_ways";
export type LinkDuration = "hour" | "day" | "always";

export const LINK_DURATIONS: readonly LinkDuration[] = ["hour", "day", "always"];
export const DEFAULT_LINK_DURATION: LinkDuration = "hour";
export const CHAT_LINK_MESSAGES_PER_HOUR = 20;

const HOUR_MS = 3_600_000;
const DURATION_MS: Record<Exclude<LinkDuration, "always">, number> = { hour: HOUR_MS, day: 24 * HOUR_MS };

export interface LinkEnd {
  agent_id: string;
  conversation_id: string;
  title: string | null;
}

/** A link between two chats, as each chat's Mac keeps it. `from` is the chat whose agent asked for it. */
export interface ChatLink {
  id: string;
  from: LinkEnd;
  to: LinkEnd;
  direction: LinkDirection;
  created_at: string;
  /** When it ends; null for a link kept until the person closes it. */
  expires_at: string | null;
  /** When each message it carried arrived, and in which chat, for the cap; only the last hour is kept. */
  sent?: Array<{ at: string; conversation_id: string }>;
}

export interface LinkAsk {
  from: LinkEnd & { agent_name: string | null };
  to: LinkEnd & { agent_name: string | null; mac: string | null };
  text: string;
  duration: LinkDuration;
}

export interface LinkAnswer {
  allow: boolean;
  direction: LinkDirection;
  duration: LinkDuration;
}

interface ChatKey {
  agent_id: string;
  conversation_id: string;
}

const same = (a: ChatKey, b: ChatKey) => a.agent_id === b.agent_id && a.conversation_id === b.conversation_id;

export const isLinkDuration = (v: unknown): v is LinkDuration => v === "hour" || v === "day" || v === "always";
export const isLinkDirection = (v: unknown): v is LinkDirection => v === "one_way" || v === "both_ways";

export function expiresAt(duration: LinkDuration, now: Date): string | null {
  return duration === "always" ? null : new Date(now.getTime() + DURATION_MS[duration]).toISOString();
}

export function isLive(link: ChatLink, now: Date): boolean {
  return link.expires_at === null || Date.parse(link.expires_at) > now.getTime();
}

export function allows(link: ChatLink, from: ChatKey, to: ChatKey, now: Date): boolean {
  if (!isLive(link, now)) return false;
  if (same(link.from, from) && same(link.to, to)) return true;
  return link.direction === "both_ways" && same(link.to, from) && same(link.from, to);
}

export function touches(link: ChatLink, chat: ChatKey): boolean {
  return same(link.from, chat) || same(link.to, chat);
}

export function otherEnd(link: ChatLink, chat: ChatKey): LinkEnd {
  return same(link.from, chat) ? link.to : link.from;
}

export function sentInHour(link: ChatLink, into: string, now: Date): number {
  const since = now.getTime() - HOUR_MS;
  return (link.sent ?? []).filter((s) => s.conversation_id === into && Date.parse(s.at) > since).length;
}

export function withSend(link: ChatLink, into: string, now: Date): ChatLink {
  const since = now.getTime() - HOUR_MS;
  const kept = (link.sent ?? []).filter((s) => Date.parse(s.at) > since);
  return { ...link, sent: [...kept, { at: now.toISOString(), conversation_id: into }] };
}

export function parseLink(v: unknown): ChatLink | null {
  if (typeof v !== "object" || v === null) return null;
  const l = v as Record<string, unknown>;
  const from = parseEnd(l.from);
  const to = parseEnd(l.to);
  if (typeof l.id !== "string" || !l.id || !from || !to || !isLinkDirection(l.direction) || typeof l.created_at !== "string") return null;
  if (l.expires_at !== null && typeof l.expires_at !== "string") return null;
  const sent = Array.isArray(l.sent)
    ? l.sent.filter(
        (s): s is { at: string; conversation_id: string } =>
          typeof s === "object" &&
          s !== null &&
          typeof (s as Record<string, unknown>).at === "string" &&
          typeof (s as Record<string, unknown>).conversation_id === "string",
      )
    : [];
  return { id: l.id, from, to, direction: l.direction, created_at: l.created_at, expires_at: l.expires_at, sent };
}

function parseEnd(v: unknown): LinkEnd | null {
  if (typeof v !== "object" || v === null) return null;
  const e = v as Record<string, unknown>;
  if (typeof e.agent_id !== "string" || !e.agent_id || typeof e.conversation_id !== "string" || !e.conversation_id) return null;
  return { agent_id: e.agent_id, conversation_id: e.conversation_id, title: typeof e.title === "string" ? e.title : null };
}

export function linkAskOf(input: unknown): LinkAsk | null {
  if (typeof input !== "object" || input === null) return null;
  const link = (input as Record<string, unknown>).link;
  if (typeof link !== "object" || link === null) return null;
  const l = link as Record<string, unknown>;
  const from = parseEnd(l.from);
  const to = parseEnd(l.to);
  if (!from || !to || typeof l.text !== "string") return null;
  const name = (e: unknown) => {
    const n = typeof e === "object" && e !== null ? (e as Record<string, unknown>).agent_name : null;
    return typeof n === "string" ? n : null;
  };
  const mac = typeof l.to === "object" && l.to !== null ? (l.to as Record<string, unknown>).mac : null;
  return {
    from: { ...from, agent_name: name(l.from) },
    to: { ...to, agent_name: name(l.to), mac: typeof mac === "string" ? mac : null },
    text: l.text,
    duration: isLinkDuration(l.duration) ? l.duration : DEFAULT_LINK_DURATION,
  };
}

export function linkAnswers(a: LinkAnswer): Record<string, string> {
  return { decision: a.allow ? "allow" : "deny", direction: a.direction, duration: a.duration };
}

export function parseLinkAnswer(answers: unknown): LinkAnswer {
  const a = typeof answers === "object" && answers !== null ? (answers as Record<string, unknown>) : {};
  return {
    allow: a.decision === "allow",
    direction: isLinkDirection(a.direction) ? a.direction : "one_way",
    duration: isLinkDuration(a.duration) ? a.duration : DEFAULT_LINK_DURATION,
  };
}

export function durationWords(d: LinkDuration): string {
  return d === "hour" ? "1 hour" : d === "day" ? "1 day" : "until I close it";
}

export function timeLeft(link: Pick<ChatLink, "expires_at">, now: Date): string {
  if (link.expires_at === null) return "until closed";
  const ms = Date.parse(link.expires_at) - now.getTime();
  if (ms <= 0) return "ended";
  const min = Math.ceil(ms / 60_000);
  return min < 60 ? `${min} min left` : `${Math.round(min / 60)} h left`;
}

const MODE_RANK = ["strict", "standard", "acceptEdits", "unrestricted"] as const;
export type LokiMode = (typeof MODE_RANK)[number];

const ACP_MODES: Record<string, LokiMode> = {
  plan: "strict",
  default: "standard",
  "read-only": "strict",
  auto: "acceptEdits",
  acceptEdits: "acceptEdits",
  "full-access": "unrestricted",
  bypassPermissions: "unrestricted",
};

export function lokiModeOf(mode: string | null | undefined, acp: boolean): LokiMode | null {
  if (!mode) return acp ? null : "unrestricted";
  if ((MODE_RANK as readonly string[]).includes(mode)) return mode as LokiMode;
  return acp ? (ACP_MODES[mode] ?? null) : "unrestricted";
}

export function stricterMode(a: LokiMode | null, b: LokiMode | null): LokiMode {
  const rank = (m: LokiMode | null) => (m ? MODE_RANK.indexOf(m) : 0);
  return rank(a) <= rank(b) ? (a ?? "strict") : (b ?? "strict");
}

export function looserThan(a: LokiMode | null, b: LokiMode): boolean {
  return (a ? MODE_RANK.indexOf(a) : MODE_RANK.length) > MODE_RANK.indexOf(b);
}

export interface LinkSeen {
  id: string;
  other: LinkEnd;
  way: "out" | "in" | "both";
  expires_at: string | null;
}

export function linksSeenFrom(links: readonly ChatLink[], chat: ChatKey): LinkSeen[] {
  return links
    .filter((l) => touches(l, chat))
    .map((l) => ({
      id: l.id,
      other: otherEnd(l, chat),
      way: l.direction === "both_ways" ? "both" : same(l.from, chat) ? "out" : "in",
      expires_at: l.expires_at,
    }));
}

export function linkAnswerWords(ask: LinkAsk, answer: LinkAnswer): string {
  const to = ask.to.title || "an untitled chat";
  if (!answer.allow) return `did not allow messaging ${to}`;
  const way = answer.direction === "both_ways" ? "both ways" : "one way";
  return `allowed messaging ${to}, ${way}, ${answer.duration === "always" ? "until closed" : `for ${durationWords(answer.duration)}`}`;
}
