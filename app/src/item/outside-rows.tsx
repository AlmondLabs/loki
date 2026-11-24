import { useState } from "react";
import type { AccountProvider, OutsideMessage, SlackReaction } from "../../../core/frame-types.ts";
import { HoverBar, ReactionRefused, SlackReplies, useReacting, type ReactControls, type RowReacting, type SlackRowAt } from "../desk/slack-thread";
import { addressIn, mailWhen, senderName, sentToLine, snippet } from "../desk/mail-thread";
import { outsideMessageEntry } from "./item-view";
import { FoldedEntry, MessageEntry } from "./message-entry";
import { emojiTitle } from "./reactions";
import { clockLabel } from "../shared/thread";

export function itemSlackRow(provider: AccountProvider) {
  return function ItemSlackRow(m: OutsideMessage, at: SlackRowAt) {
    return (
      <div className="loki-slack-row py-1" data-row-item>
        {at.reacting && <HoverBar reacting={at.reacting} />}
        <MessageEntry
          entry={outsideMessageEntry(m, provider)}
          source={provider}
          first={at.first}
          when={slackWhen(m.at, at.dayNote)}
          onReact={at.reacting?.toggle}
        >
          {at.reacting?.refused && <ReactionRefused text={at.reacting.refused} />}
          {at.reacting?.picker}
          {!at.jira && <SlackReplies m={m} onOpen={at.onOpen} />}
        </MessageEntry>
      </div>
    );
  };
}

export function ItemMailThread({
  messages,
  own,
  // oxlint-disable-next-line react/purity -- a fresh clock each render is the point: the relative times move on as the view re-renders.
  now = new Date(),
  newest = "",
  reacting = null,
}: {
  messages: readonly OutsideMessage[];
  own: readonly string[];
  now?: Date;
  newest?: string;
  reacting?: ReactControls | null;
}) {
  const reactingOn = useReacting(messages, newest, reacting, true);
  return (
    <div className="flex flex-col divide-y divide-border" data-mail-thread>
      {messages.map((m, i) => (
        <ItemMail key={m.id} m={m} own={own} folded={i < messages.length - 1} now={now} reacting={reactingOn(m)} />
      ))}
    </div>
  );
}

function ItemMail({ m, own, folded, now, reacting }: { m: OutsideMessage; own: readonly string[]; folded: boolean; now: Date; reacting?: RowReacting }) {
  const [opened, setOpened] = useState(false);
  const name = m.mine ? "You" : senderName(m.sender);
  const when = mailEntryWhen(m.at, now);
  if (folded && !opened && !reacting?.picker)
    return (
      <FoldedEntry who={name} avatar={m.avatar ?? null} when={when} at={m.at} line={snippet(m.text)} onOpen={() => setOpened(true)}>
        {m.reactions?.length ? <FoldedReactions reactions={m.reactions} /> : null}
      </FoldedEntry>
    );
  const address = addressIn(m.sender);
  return (
    <div className="loki-slack-row flex flex-col gap-1 px-2 py-1" data-row-item>
      {reacting && <HoverBar reacting={reacting} />}
      <MessageEntry
        entry={{ ...outsideMessageEntry(m, "gmail"), who: name }}
        source="gmail"
        when={when}
        detail={!m.mine && address && address !== name ? address : null}
        line={sentToLine(m, own) || null}
        onReact={reacting?.toggle}
        undoable={false}
      >
        {reacting?.refused && <ReactionRefused text={reacting.refused} />}
        {reacting?.picker}
      </MessageEntry>
    </div>
  );
}

function slackWhen(at: string, dayNote: string | null): string | null {
  const clock = clockLabel(at);
  return clock && dayNote ? `${dayNote} at ${clock}` : clock;
}

function mailEntryWhen(at: string, now: Date): string | null {
  if (!at) return null;
  const today = new Date(at).toDateString() === now.toDateString();
  return (today ? clockLabel(at) : null) ?? (mailWhen(at, now) || null);
}

function FoldedReactions({ reactions }: { reactions: readonly SlackReaction[] }) {
  return (
    <span className="flex shrink-0 gap-1 text-xs tabular-nums text-muted-foreground" data-folded-reactions>
      {reactions.map((r) => (
        <span key={r.name} title={emojiTitle(r)} data-mine={r.mine ? "true" : undefined}>
          {r.emoji?.text ?? r.name} {r.count}
        </span>
      ))}
    </span>
  );
}
