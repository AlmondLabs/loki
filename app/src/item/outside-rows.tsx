import { useState } from "react";
import type { AccountProvider, OutsideMessage } from "../../../core/frame-types.ts";
import { HoverBar, SlackReplies, type SlackRowAt } from "../desk/slack-thread";
import { addressIn, mailWhen, senderName, sentToLine, snippet } from "../desk/mail-thread";
import { outsideMessageEntry } from "./item-view";
import { MessageEntry } from "./message-entry";

/**
 * A Slack message or a Jira comment drawn as a MessageEntry, for the Slack card's thread (plan 097, U7). The thread
 * keeps its own window, loading, scrolling and reacting (slack-thread.tsx); only the row is the item's: the sender's
 * picture and name on the first of a run, the words through ContentParts, reactions that toggle the person's own, the
 * hover bar of quick reactions, the picker, and a post's replies.
 */
export function itemSlackRow(provider: AccountProvider) {
  return function ItemSlackRow(m: OutsideMessage, at: SlackRowAt) {
    return (
      <div className="loki-slack-row py-1" data-row-item>
        {at.reacting && <HoverBar reacting={at.reacting} />}
        <MessageEntry entry={outsideMessageEntry(m, provider)} source={provider} first={at.first} note={at.dayNote} onReact={at.reacting?.toggle}>
          {at.reacting?.picker}
          {!at.jira && <SlackReplies m={m} onOpen={at.onOpen} />}
        </MessageEntry>
      </div>
    );
  };
}

/**
 * An email thread on the item components (plan 097, U7): oldest first, each mail before the newest folded to its
 * sender, time and first line until pressed, as a mail client shows a thread; an open one is a MessageEntry with its
 * address and who it went to under the name, and its HTML in the locked frame.
 */
export function ItemMailThread({ messages, own, now = new Date() }: { messages: readonly OutsideMessage[]; own: readonly string[]; now?: Date }) {
  return (
    <div className="flex flex-col gap-3" data-mail-thread>
      {messages.map((m, i) => (
        <ItemMail key={m.id} m={m} own={own} folded={i < messages.length - 1} now={now} />
      ))}
    </div>
  );
}

function ItemMail({ m, own, folded, now }: { m: OutsideMessage; own: readonly string[]; folded: boolean; now: Date }) {
  const [opened, setOpened] = useState(false);
  const name = m.mine ? "you" : senderName(m.sender);
  const when = m.at ? mailWhen(m.at, now) : "";
  if (folded && !opened)
    return (
      <button
        type="button"
        aria-expanded={false}
        onClick={() => setOpened(true)}
        className="flex w-full min-w-0 cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-body hover:bg-muted"
      >
        <span className="shrink-0 font-semibold">{name}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{snippet(m.text)}</span>
        {when && <span className="shrink-0 text-meta text-muted-foreground">{when}</span>}
      </button>
    );
  const address = addressIn(m.sender);
  const sentTo = sentToLine(m, own);
  const line = [address && address !== name ? address : null, sentTo || null].filter(Boolean).join(" · ");
  const entry = { ...outsideMessageEntry(m, "gmail"), who: m.mine ? "You" : senderName(m.sender) };
  return (
    <div className="flex flex-col gap-1">
      <MessageEntry entry={entry} source="gmail" status={m.mine ? sentTo || null : null} note={!m.mine && line ? line : null} />
    </div>
  );
}
