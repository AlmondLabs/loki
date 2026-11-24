import { useState } from "react";
import type { AccountProvider, OutsideMessage, SlackReaction } from "../../../core/frame-types.ts";
import { HoverBar, ReactionRefused, SlackReplies, useReacting, type ReactControls, type RowReacting, type SlackRowAt } from "../desk/slack-thread";
import { addressIn, mailWhen, senderName, sentToLine, snippet } from "../desk/mail-thread";
import { outsideMessageEntry } from "./item-view";
import { MessageEntry } from "./message-entry";
import { emojiTitle } from "./reactions";

export function itemSlackRow(provider: AccountProvider) {
  return function ItemSlackRow(m: OutsideMessage, at: SlackRowAt) {
    return (
      <div className="loki-slack-row py-1" data-row-item>
        {at.reacting && <HoverBar reacting={at.reacting} />}
        <MessageEntry entry={outsideMessageEntry(m, provider)} source={provider} first={at.first} note={at.dayNote} onReact={at.reacting?.toggle}>
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
    <div className="flex flex-col gap-3" data-mail-thread>
      {messages.map((m, i) => (
        <ItemMail key={m.id} m={m} own={own} folded={i < messages.length - 1} now={now} reacting={reactingOn(m)} />
      ))}
    </div>
  );
}

function ItemMail({ m, own, folded, now, reacting }: { m: OutsideMessage; own: readonly string[]; folded: boolean; now: Date; reacting?: RowReacting }) {
  const [opened, setOpened] = useState(false);
  const name = m.mine ? "you" : senderName(m.sender);
  const when = m.at ? mailWhen(m.at, now) : "";
  if (folded && !opened && !reacting?.picker)
    return (
      <button
        type="button"
        aria-expanded={false}
        onClick={() => setOpened(true)}
        className="flex w-full min-w-0 cursor-pointer items-baseline gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted"
      >
        <span className="shrink-0 font-semibold">{name}</span>
        <span className="loki-truncate flex-1 text-muted-foreground">{snippet(m.text)}</span>
        {m.reactions?.length ? <FoldedReactions reactions={m.reactions} /> : null}
        {when && <span className="shrink-0 text-xs text-muted-foreground">{when}</span>}
      </button>
    );
  const address = addressIn(m.sender);
  const sentTo = sentToLine(m, own);
  const line = [address && address !== name ? address : null, sentTo || null].filter(Boolean).join(" · ");
  const entry = { ...outsideMessageEntry(m, "gmail"), who: m.mine ? "You" : senderName(m.sender) };
  return (
    <div className="loki-slack-row flex flex-col gap-1" data-row-item>
      {reacting && <HoverBar reacting={reacting} />}
      <MessageEntry
        entry={entry}
        source="gmail"
        status={m.mine ? sentTo || null : null}
        note={!m.mine && line ? line : null}
        onReact={reacting?.toggle}
        undoable={false}
      >
        {reacting?.refused && <ReactionRefused text={reacting.refused} />}
        {reacting?.picker}
      </MessageEntry>
    </div>
  );
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
