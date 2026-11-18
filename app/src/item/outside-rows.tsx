import { useState } from "react";
import type { AccountProvider, OutsideMessage } from "../../../core/frame-types.ts";
import { HoverBar, SlackReplies, type SlackRowAt } from "../desk/slack-thread";
import { addressIn, mailWhen, senderName, sentToLine, snippet } from "../desk/mail-thread";
import { outsideMessageEntry } from "./item-view";
import { MessageEntry } from "./message-entry";

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

// oxlint-disable-next-line react/purity -- a fresh clock each render is the point: the relative times move on as the view re-renders.
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
        className="flex w-full min-w-0 cursor-pointer items-baseline gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted"
      >
        <span className="shrink-0 font-semibold">{name}</span>
        <span className="loki-truncate flex-1 text-muted-foreground">{snippet(m.text)}</span>
        {when && <span className="shrink-0 text-xs text-muted-foreground">{when}</span>}
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
