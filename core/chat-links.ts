/**
 * Chat links (plan 067): the person's leave for one chat to message another, for a while. A link is opened only on the
 * card a chat shows when its agent first messages a chat it has no link to, and the person picks its direction and how
 * long it lasts there. The rules here are shared by the mod, which keeps and checks links, and the app, which draws
 * the card, the header's link and Preferences › Chat › Chat links.
 */

/** Which way messages may go: only from the chat that asked to the other, or each to the other. */
export type LinkDirection = "one_way" | "both_ways";
/** How long a link lasts: an hour, a day, or until the person closes it. */
export type LinkDuration = "hour" | "day" | "always";

/** Every duration, in the order the card offers them. */
export const LINK_DURATIONS: readonly LinkDuration[] = ["hour", "day", "always"];
/** The duration the card starts on until the person picks another default in Preferences. */
export const DEFAULT_LINK_DURATION: LinkDuration = "hour";
/** The most messages a link carries into one of its chats in an hour; past it, a message is refused. */
export const CHAT_LINK_MESSAGES_PER_HOUR = 20;

const HOUR_MS = 3_600_000;
const DURATION_MS: Record<Exclude<LinkDuration, "always">, number> = { hour: HOUR_MS, day: 24 * HOUR_MS };

/** One end of a link: a chat, with its name when the link was opened, for the lists that show it. */
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

/** What the link card shows (the `link` of a question event's input): the two chats, the message, and the default. */
export interface LinkAsk {
  from: LinkEnd & { agent_name: string | null };
  to: LinkEnd & { agent_name: string | null; mac: string | null };
  text: string;
  duration: LinkDuration;
}

/** The person's answer on the link card, as it comes back in the question's `answers`. */
export interface LinkAnswer {
  allow: boolean;
  direction: LinkDirection;
  duration: LinkDuration;
}

/** A chat as a pair of ids. */
interface ChatKey {
  agent_id: string;
  conversation_id: string;
}

const same = (a: ChatKey, b: ChatKey) => a.agent_id === b.agent_id && a.conversation_id === b.conversation_id;

/** Whether a value is one of the durations. */
export const isLinkDuration = (v: unknown): v is LinkDuration => v === "hour" || v === "day" || v === "always";
/** Whether a value is one of the directions. */
export const isLinkDirection = (v: unknown): v is LinkDirection => v === "one_way" || v === "both_ways";

/** When a link opened now for this long ends; null for one kept until closed. */
export function expiresAt(duration: LinkDuration, now: Date): string | null {
  return duration === "always" ? null : new Date(now.getTime() + DURATION_MS[duration]).toISOString();
}

/** Whether a link still holds now. */
export function isLive(link: ChatLink, now: Date): boolean {
  return link.expires_at === null || Date.parse(link.expires_at) > now.getTime();
}

/** Whether a live link lets `from` message `to`: in its own direction always, back the other way only both ways. */
export function allows(link: ChatLink, from: ChatKey, to: ChatKey, now: Date): boolean {
  if (!isLive(link, now)) return false;
  if (same(link.from, from) && same(link.to, to)) return true;
  return link.direction === "both_ways" && same(link.to, from) && same(link.from, to);
}

/** Whether a link joins this chat, at either end. */
export function touches(link: ChatLink, chat: ChatKey): boolean {
  return same(link.from, chat) || same(link.to, chat);
}

/** The other end of a link, seen from one of its chats. */
export function otherEnd(link: ChatLink, chat: ChatKey): LinkEnd {
  return same(link.from, chat) ? link.to : link.from;
}

/** The messages a link carried into a chat in the hour before now. */
export function sentInHour(link: ChatLink, into: string, now: Date): number {
  const since = now.getTime() - HOUR_MS;
  return (link.sent ?? []).filter((s) => s.conversation_id === into && Date.parse(s.at) > since).length;
}

/** The link with one more message into a chat, keeping only the last hour's. */
export function withSend(link: ChatLink, into: string, now: Date): ChatLink {
  const since = now.getTime() - HOUR_MS;
  const kept = (link.sent ?? []).filter((s) => Date.parse(s.at) > since);
  return { ...link, sent: [...kept, { at: now.toISOString(), conversation_id: into }] };
}

/** A link as another Mac or a file sent it, or null when it is not one. */
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

/** The link card's input, or null when a question is not a link card. */
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

/** The answers the link card sends back, as `answers` in the question's input. */
export function linkAnswers(a: LinkAnswer): Record<string, string> {
  return { decision: a.allow ? "allow" : "deny", direction: a.direction, duration: a.duration };
}

/** The person's answer read back from the card's answers; a deny for anything that is not an allow. */
export function parseLinkAnswer(answers: unknown): LinkAnswer {
  const a = typeof answers === "object" && answers !== null ? (answers as Record<string, unknown>) : {};
  return {
    allow: a.decision === "allow",
    direction: isLinkDirection(a.direction) ? a.direction : "one_way",
    duration: isLinkDuration(a.duration) ? a.duration : DEFAULT_LINK_DURATION,
  };
}

/** A duration as the card and Preferences say it. */
export function durationWords(d: LinkDuration): string {
  return d === "hour" ? "1 hour" : d === "day" ? "1 day" : "until I close it";
}

/** How long a link has left, in a few words: "45 min left", "3 h left", or "until closed". */
export function timeLeft(link: Pick<ChatLink, "expires_at">, now: Date): string {
  if (link.expires_at === null) return "until closed";
  const ms = Date.parse(link.expires_at) - now.getTime();
  if (ms <= 0) return "ended";
  const min = Math.ceil(ms / 60_000);
  return min < 60 ? `${min} min left` : `${Math.round(min / 60)} h left`;
}

// Permission modes, ranked by the power a turn has: a chat message never gives the turn it starts more than the chat
// that sent it has.

/** loki's permission modes from least to most power: strict asks for everything, unrestricted for nothing. */
const MODE_RANK = ["strict", "standard", "acceptEdits", "unrestricted"] as const;
/** One of loki's permission modes. */
export type LokiMode = (typeof MODE_RANK)[number];

/** The ACP agents' own mode ids loki knows, as loki's mode with the same power (Claude Code's, Codex's). */
const ACP_MODES: Record<string, LokiMode> = {
  plan: "strict",
  default: "standard",
  "read-only": "strict",
  auto: "acceptEdits",
  acceptEdits: "acceptEdits",
  "full-access": "unrestricted",
  bypassPermissions: "unrestricted",
};

/**
 * A chat's mode as loki's: its own when it is one of loki's, an ACP agent's when loki knows it, else null. A chat with
 * no mode set on loki's engine runs unrestricted (daemon/approvals.ts DEFAULT_MODE), so the caller says which engine.
 */
export function lokiModeOf(mode: string | null | undefined, acp: boolean): LokiMode | null {
  if (!mode) return acp ? null : "unrestricted";
  if ((MODE_RANK as readonly string[]).includes(mode)) return mode as LokiMode;
  return acp ? (ACP_MODES[mode] ?? null) : "unrestricted";
}

/** The mode with less power of two; an unknown mode counts as strict, so not knowing never gives power. */
export function stricterMode(a: LokiMode | null, b: LokiMode | null): LokiMode {
  const rank = (m: LokiMode | null) => (m ? MODE_RANK.indexOf(m) : 0);
  return rank(a) <= rank(b) ? (a ?? "strict") : (b ?? "strict");
}

/** Whether a mode has more power than another: what a chat on an ACP agent, whose mode loki cannot lower, is refused for. */
export function looserThan(a: LokiMode | null, b: LokiMode): boolean {
  // An ACP mode loki does not know may be any, so it counts as the loosest.
  return (a ? MODE_RANK.indexOf(a) : MODE_RANK.length) > MODE_RANK.indexOf(b);
}

/** A link as one of its chats shows it: the other chat, which way messages go from here, and when it ends. */
export interface LinkSeen {
  id: string;
  other: LinkEnd;
  /** "out": this chat may message the other; "in": the other may message this one; "both": each may. */
  way: "out" | "in" | "both";
  expires_at: string | null;
}

/** A chat's links as its header shows them. */
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

/** The person's answer on the link card, as the thread shows it under their name. */
export function linkAnswerWords(ask: LinkAsk, answer: LinkAnswer): string {
  const to = ask.to.title || "an untitled chat";
  if (!answer.allow) return `did not allow messaging ${to}`;
  const way = answer.direction === "both_ways" ? "both ways" : "one way";
  return `allowed messaging ${to}, ${way}, ${answer.duration === "always" ? "until closed" : `for ${durationWords(answer.duration)}`}`;
}
