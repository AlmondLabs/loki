import type { ReplyMention } from "../frame-types.ts";
import { liveMentions } from "../mentions.ts";

/**
 * The people the person picked from a reply box's `@` list (plan 2026-11-14-1530, R23, KTD8), kept per account for
 * this session, so the send of an outside card's reply carries them as mentions wherever the box's text is held. Only a
 * pick lands here: a name typed by hand stays text. The send keeps only those still written in the text.
 */
export class PickedPeople {
  private readonly picked = new Map<string, ReplyMention[]>();

  /** The person picked a mention in a box of this account. */
  add(accountId: string, mention: ReplyMention): void {
    const had = this.picked.get(accountId) ?? [];
    if (had.some((m) => m.display === mention.display && m.id === mention.id && m.address === mention.address)) return;
    this.picked.set(accountId, [...had, mention]);
  }

  /** The picked people of this account whose `@display` stands in `text`: what its send mentions. */
  in(accountId: string, text: string): ReplyMention[] {
    return liveMentions(text, this.picked.get(accountId) ?? []);
  }
}
