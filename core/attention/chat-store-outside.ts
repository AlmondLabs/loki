import type { ChatClient } from "./chat-client.ts";
import { OUTSIDE_ENDS, type ConversationInfo } from "./model.ts";
import type {
  AccountLabel,
  EmojiChoice,
  HandoffProposal,
  MailAddressing,
  MailCompose,
  OutsideChange,
  OutsideMove,
  OutsideRead,
  OutsideWindowAsk,
  ReplyThen,
  SlackPerson,
} from "../frame-types.ts";
import { sentKey, type SentReplies } from "./sent-replies.ts";
import type { PickedPeople } from "./picked-people.ts";
import { NOT_OUTSIDE } from "./chat-store-helpers.ts";
import type { OutsideCardRef, OutsideWritten } from "./chat-store-types.ts";

export interface OutsideActionsHost {
  sent: SentReplies;
  picked: PickedPeople;
  now: () => number;
  attempt: <T>(work: (client: ChatClient) => Promise<T>) => Promise<T | string>;
  tried: (work: (client: ChatClient) => Promise<unknown>) => Promise<string | null>;
  reload: () => void;
  dropCard: (card: Pick<ConversationInfo, "agent_id" | "id">) => void;
  dropCardImmediately: (card: Pick<ConversationInfo, "agent_id" | "id">) => void;
}

export function createOutsideActions(host: OutsideActionsHost) {
  const writeOutside = async (
    card: OutsideCardRef,
    work: (client: ChatClient, outside: NonNullable<ConversationInfo["outside"]>, home: string | null) => Promise<OutsideChange | null>,
  ): Promise<OutsideWritten> => {
    const o = card.outside;
    if (!o) return { change: null, error: NOT_OUTSIDE };
    const r = await host.attempt((c) => work(c, o, card.home ?? null));
    if (typeof r === "string") return { change: null, error: r };
    if (r?.ended) host.dropCard(card);
    return { change: r, error: null };
  };

  return {
    archiveOutside: async (card: OutsideCardRef): Promise<OutsideWritten> => {
      if (card.outside && !OUTSIDE_ENDS[card.outside.provider].archive) return { change: null, error: "a jira card ends with read" };
      const r = await writeOutside(card, (c, o, home) => c.archiveOutside(o.account_id, o.thread_id, home));
      if (!r.error) host.dropCard(card);
      return r;
    },

    markReadOutside: (card: OutsideCardRef): Promise<OutsideWritten> => writeOutside(card, (c, o, home) => c.markReadOutside(o.account_id, o.thread_id, home)),

    markUnreadOutside: (card: OutsideCardRef): Promise<OutsideWritten> =>
      writeOutside(card, (c, o, home) => c.markUnreadOutside(o.account_id, o.thread_id, home)),

    labelOutside: (card: OutsideCardRef, labels: string[]): Promise<OutsideWritten> =>
      writeOutside(card, (c, o, home) => c.labelOutside(o.account_id, o.thread_id, labels, home)),

    restoreOutside: async (card: OutsideCardRef, change: OutsideChange): Promise<string | null> => {
      const o = card.outside;
      if (!o) return NOT_OUTSIDE;
      const err = await host.tried((c) => c.restoreOutside(o.account_id, o.thread_id, change, card.home ?? null));
      if (!err && change.ended) host.reload();
      return err;
    },

    labelsOf: async (card: Pick<ConversationInfo, "outside" | "home">): Promise<AccountLabel[] | string> => {
      const o = card.outside;
      if (!o) return NOT_OUTSIDE;
      return host.attempt((c) => c.labelsOutside(o.account_id, card.home ?? null));
    },

    readOutside: async (card: Pick<ConversationInfo, "outside" | "home">, ask: OutsideWindowAsk = {}): Promise<OutsideRead | string> => {
      const o = card.outside;
      if (!o) return "this card is not from an account";
      return host.attempt((c) => c.readOutside(o.account_id, o.thread_id, card.home ?? null, ask));
    },

    replyOutside: async (
      card: Pick<ConversationInfo, "agent_id" | "id" | "outside" | "home">,
      text: string,
      then: ReplyThen,
      extra: { mail?: MailAddressing | null; outbox_id?: string | null; thread_ts?: string | null } = {},
    ): Promise<{ sent: boolean; error: string | null; change: OutsideChange | null; undone?: true }> => {
      const o = card.outside;
      if (!o) return { sent: false, error: "this card is not from an account", change: null };
      const place = sentKey(o.account_id, o.thread_id, extra.thread_ts ?? null);
      const shown = then === "stay" ? host.sent.add(place, text.trim(), new Date(host.now()).toISOString()) : null;
      const mentions = host.picked.in(o.account_id, text);
      const r = await host.attempt((c) => c.replyOutside(o.account_id, o.thread_id, text, then, card.home ?? null, { ...extra, mentions }));
      if (shown) {
        if (typeof r === "string" || !r.sent) host.sent.drop(shown);
        else host.sent.went(shown);
      }
      if (typeof r === "string") return { sent: false, error: r, change: null };
      if (!r.sent) return { sent: false, error: null, change: null, undone: true };
      if (r.change?.ended) host.dropCard(card);
      return { sent: true, error: r.then_error, change: r.change };
    },

    composeOutside: async (card: Pick<ConversationInfo, "outside" | "home">): Promise<MailCompose | string> => {
      const o = card.outside;
      if (o?.provider !== "gmail") return "this card is not a mail";
      return host.attempt((c) => c.composeOutside(o.account_id, o.thread_id, card.home ?? null));
    },

    reactOutside: async (card: Pick<ConversationInfo, "outside" | "home">, messageId: string, name: string, on: boolean): Promise<string | null> => {
      const o = card.outside;
      if (!o) return "only a Slack message or a mail takes a reaction";
      if (o.provider === "jira") return "a Jira comment takes no reaction";
      const r = await host.attempt((c) => c.reactOutside(o.account_id, o.thread_id, messageId, name, on, card.home ?? null));
      return typeof r === "string" ? r : null;
    },

    searchEmoji: async (card: Pick<ConversationInfo, "outside" | "home">, query: string): Promise<EmojiChoice[] | string> => {
      const o = card.outside;
      if (!o) return "only a Slack message or a mail takes a reaction";
      if (o.provider === "jira") return "a Jira comment takes no reaction";
      return host.attempt((c) => c.searchEmoji(o.account_id, query, card.home ?? null));
    },

    pickPerson: (card: Pick<ConversationInfo, "outside">, person: SlackPerson): void => {
      const o = card.outside;
      if (o?.provider === "slack") host.picked.add(o.account_id, { display: person.name, id: person.id, address: null });
    },

    searchPeople: async (card: Pick<ConversationInfo, "outside" | "home">, query: string): Promise<SlackPerson[] | string> => {
      const o = card.outside;
      if (o?.provider !== "slack") return "only a Slack account has people to mention";
      return host.attempt((c) => c.searchPeople(o.account_id, query, card.home ?? null));
    },

    unsendOutside: async (card: Pick<ConversationInfo, "outside" | "home">, outboxId: string): Promise<boolean> => {
      const o = card.outside;
      if (!o) return false;
      const r = await host.attempt((c) => c.unsendOutside(o.account_id, outboxId, card.home ?? null));
      return r === true;
    },

    settleUnsent: async (card: Pick<ConversationInfo, "outside" | "home">, outboxId: string, action: "resend" | "discard"): Promise<string | null> => {
      const o = card.outside;
      if (!o) return NOT_OUTSIDE;
      const home = card.home ?? null;
      if (action === "discard") {
        const r = await host.attempt((c) => c.discardOutside(o.account_id, outboxId, home));
        if (typeof r === "string") return r;
        host.reload();
        return null;
      }
      const r = await host.attempt((c) => c.resendOutside(o.account_id, o.thread_id, outboxId, home));
      if (typeof r === "string") return r;
      host.reload();
      return r.sent && r.then_error ? `sent, but ${r.then_error}` : null;
    },

    moveOutside: (card: Pick<ConversationInfo, "outside" | "home">, move: OutsideMove): void => {
      const o = card.outside;
      if (o) void host.tried((c) => c.moveOutside(o.account_id, o.thread_id, move, card.home ?? null));
    },

    handoffPropose: async (card: Pick<ConversationInfo, "outside" | "home">): Promise<HandoffProposal | string> => {
      const o = card.outside;
      if (!o) return "this card is not from an account";
      return host.attempt((c) => c.handoffPropose(o.account_id, o.thread_id, card.home ?? null));
    },

    handoff: async (card: Pick<ConversationInfo, "agent_id" | "id" | "outside" | "home">, conversationId: string | null): Promise<string | null> => {
      const o = card.outside;
      if (!o) return "this card is not from an account";
      const err = await host.tried((c) => c.handoff(o.account_id, o.thread_id, conversationId, card.home ?? null));
      if (err) return err;
      if (!OUTSIDE_ENDS[o.provider].handoff) return null;
      host.dropCardImmediately(card);
      return null;
    },
  };
}
