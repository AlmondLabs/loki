import type { SlackReaction } from "../core/frame-types.ts";
import { mailTraits } from "../core/mail-filter.ts";
import { headerPeople } from "../core/mail-header.ts";
import type { GmailClient, GmailMessage, GmailMessagePart } from "./gmail.ts";
import { GoogleError, RATE_LIMITS } from "./google-auth.ts";
import { emojiName } from "./slack-markup.ts";

const REACTION_TYPE = "text/vnd.google.email-reaction+json";
const FORWARDED_MAIL = "message/rfc822";

const isAttachment = (part: GmailMessagePart) =>
  part.filename !== "" || part.headers.some((h) => h.name.toLowerCase() === "content-disposition" && /^\s*attachment/i.test(h.value));

function reactionPart(part: GmailMessagePart): GmailMessagePart | null {
  const type = part.mimeType.toLowerCase();
  if (type === FORWARDED_MAIL || isAttachment(part)) return null;
  if (type === REACTION_TYPE) return part.body.data ? part : null;
  for (const p of part.parts) {
    const found = reactionPart(p);
    if (found) return found;
  }
  return null;
}

function emojiOf(json: string): string | null {
  let body: unknown;
  try {
    body = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || !("version" in body) || !("emoji" in body)) return null;
  const { version, emoji } = body;
  return version === 1 && typeof emoji === "string" && emoji.trim() !== "" ? emoji.trim() : null;
}

export function reactionOf(m: GmailMessage): string | null {
  const part = m.payload ? reactionPart(m.payload) : null;
  const data = part?.body.data;
  return data ? emojiOf(Buffer.from(data, "base64url").toString("utf8")) : null;
}

const VERDICTS_KEPT = 10_000;

const header = (m: GmailMessage, name: string) => m.payload?.headers.find((h) => h.name.toLowerCase() === name)?.value ?? "";
const mightBeReaction = (m: GmailMessage) => header(m, "in-reply-to").trim() !== "" && /^\s*multipart\//i.test(header(m, "content-type"));
const isRetried = (error: unknown) =>
  !(error instanceof GoogleError) || error.status === 429 || error.status >= 500 || (error.reason !== null && RATE_LIMITS.includes(error.reason));

export class MailReactions {
  private readonly verdicts = new Map<string, string | null>();
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private readonly client: Pick<GmailClient, "getMessage">;

  constructor(client: Pick<GmailClient, "getMessage">) {
    this.client = client;
  }

  saw(m: GmailMessage): string | null {
    const emoji = reactionOf(m);
    this.keep(m.id, emoji);
    return emoji;
  }

  known(m: GmailMessage): string | null | undefined {
    return this.verdicts.get(m.id);
  }

  async of(m: GmailMessage): Promise<string | null> {
    const known = this.verdicts.get(m.id);
    if (known !== undefined) return known;
    if (!mightBeReaction(m)) return null;
    const active = this.inFlight.get(m.id);
    if (active) return active;
    const task = (async () => {
      try {
        return this.saw(await this.client.getMessage(m.id));
      } catch (error) {
        if (isRetried(error)) throw error;
        return null;
      } finally {
        this.inFlight.delete(m.id);
      }
    })();
    this.inFlight.set(m.id, task);
    return task;
  }

  private keep(id: string, emoji: string | null): void {
    this.verdicts.delete(id);
    this.verdicts.set(id, emoji);
    for (const oldest of this.verdicts.keys()) {
      if (this.verdicts.size <= VERDICTS_KEPT) break;
      this.verdicts.delete(oldest);
    }
  }
}

const MOST_RECIPIENTS = 20;
const MOST_OWN_REACTIONS = 20;
const ENCRYPTED = ["multipart/encrypted", "application/pkcs7-mime", "application/x-pkcs7-mime"];

const addressOf = (from: string) => (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
const messageIdOf = (m: GmailMessage, name: string) => header(m, name).trim().toLowerCase();
export const drawnEmoji = (emoji: string) => emoji.replaceAll("\u{FE0F}", "");

export interface MailReactionsOf {
  reactions: SlackReaction[];
  reactable: boolean;
}

function takesReactions(m: GmailMessage, own: ReadonlySet<string>, ownReactions: number): boolean {
  const headers = m.payload?.headers ?? [];
  const traits = mailTraits(headers, [...own]);
  const recipients = new Set([...headerPeople(header(m, "to")), ...headerPeople(header(m, "cc"))].map((p) => p.address));
  const fromYou = own.has(addressOf(header(m, "from")));
  const encrypted = ENCRYPTED.includes((m.payload?.mimeType ?? "").toLowerCase());
  return !traits.list && recipients.size <= MOST_RECIPIENTS && (fromYou || traits.to_you) && !encrypted && ownReactions < MOST_OWN_REACTIONS;
}

export function foldReactions(
  messages: readonly GmailMessage[],
  reactionIn: (m: GmailMessage) => string | null,
  ownAddresses: readonly string[],
): {
  mails: GmailMessage[];
  of: Map<string, MailReactionsOf>;
} {
  const own = new Set(ownAddresses.map((a) => a.trim().toLowerCase()));
  const emoji = new Map(messages.map((m) => [m.id, reactionIn(m)]));
  const mails = messages.filter((m) => emoji.get(m.id) === null);
  const byMessageId = new Map(mails.map((m) => [messageIdOf(m, "message-id"), m] as const).filter(([id]) => id !== ""));
  const senders = new Map<string, Map<string, { emoji: string; people: Set<string> }>>();
  const ownCount = new Map<string, number>();
  for (const r of messages) {
    const e = emoji.get(r.id);
    const target = e ? byMessageId.get(messageIdOf(r, "in-reply-to")) : undefined;
    if (!e || !target) continue;
    const sender = addressOf(header(r, "from"));
    const pills = senders.get(target.id) ?? new Map<string, { emoji: string; people: Set<string> }>();
    const pill = pills.get(drawnEmoji(e)) ?? { emoji: e, people: new Set<string>() };
    pill.people.add(sender);
    pills.set(drawnEmoji(e), pill);
    senders.set(target.id, pills);
    if (own.has(sender)) ownCount.set(target.id, (ownCount.get(target.id) ?? 0) + 1);
  }
  const of = new Map<string, MailReactionsOf>();
  for (const m of mails) {
    const reactions = [...(senders.get(m.id)?.values() ?? [])].map((p): SlackReaction => ({
      name: emojiName(p.emoji),
      count: p.people.size,
      mine: [...p.people].some((a) => own.has(a)),
      emoji: { kind: "emoji", text: p.emoji },
    }));
    of.set(m.id, { reactions, reactable: takesReactions(m, own, ownCount.get(m.id) ?? 0) });
  }
  return { mails, of };
}
