import type { ReplyMention } from "../frame-types.ts";
import { lastByName, liveMentions } from "../mentions.ts";

export class PickedPeople {
  private readonly picked = new Map<string, ReplyMention[]>();

  add(accountId: string, mention: ReplyMention): void {
    this.picked.set(accountId, lastByName([...(this.picked.get(accountId) ?? []), mention]));
  }

  in(accountId: string, text: string): ReplyMention[] {
    return liveMentions(text, this.picked.get(accountId) ?? []);
  }
}
