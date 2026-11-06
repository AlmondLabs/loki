import { Fragment, useEffect, useRef, type ReactNode } from "react";
import type { OutsideMessage } from "../../../core/frame-types.ts";
import { clockLabel, dayPills } from "../shared/thread";
import { AgentFace } from "./agent-chip";
import { LinkedText } from "./mail-html";

/** Two messages by one person this close together read as one run, under one face and name, as Slack draws them. */
const RUN_GAP_MS = 5 * 60_000;

/** Where each message sits in the card: what starts before it, and whether it opens a run of one person's messages. */
export interface SlackRowPlan {
  /** The day pill before it, Slack's ("Today", "Yesterday", a weekday, a date); null when the day goes on. */
  day: string | null;
  /** The red New line before it: the first message the person has not read. */
  divider: boolean;
  /** It starts a run: a new person, a gap, a new day, the New line, or into or out of the open thread. */
  first: boolean;
}

/** Each message's day pill, New line and run start, in the card's order (plan 074). */
export function planSlackRows(messages: readonly OutsideMessage[], now: number = Date.now()): SlackRowPlan[] {
  const days = dayPills(messages, now);
  const newAt = messages.findIndex((m) => m.unread === true);
  return messages.map((m, i) => {
    const prev = i > 0 ? messages[i - 1] : null;
    const day = days[i];
    const divider = i === newAt;
    const gap = prev ? Date.parse(m.at) - Date.parse(prev.at) : Number.NaN;
    const first =
      !prev || day !== null || divider || prev.sender !== m.sender || (prev.in_thread === true) !== (m.in_thread === true) || !(gap >= 0 && gap < RUN_GAP_MS);
    return { day, divider, first };
  });
}

/** The words Slack sends to a whole channel, which the card marks as a mention. */
const BROADCAST = /(@(?:channel|here|everyone))\b/;

/** A message's text with its links made links and @channel, @here and @everyone marked, as Slack marks them. */
function SlackText({ text }: { text: string }): ReactNode {
  // Each part is keyed by its kind and where it starts in the text: an empty text part and the mention after it share a start.
  let at = 0;
  return text.split(BROADCAST).map((part, i) => {
    const key = at;
    at += part.length;
    return i % 2 === 1 ? (
      <span key={`mention-${key}`} className="loki-mention">
        {part}
      </span>
    ) : (
      <LinkedText key={`text-${key}`} text={part} />
    );
  });
}

/** One message as the chat draws one: a face and name on the first of a run, its time beside the name. */
function SlackRow({ m, first }: { m: OutsideMessage; first: boolean }) {
  const time = clockLabel(m.at);
  const name = m.mine ? "you" : m.sender;
  return (
    <div className="loki-msg" data-first={first ? "true" : undefined}>
      <span className="loki-msg-face" aria-hidden>
        {first && <AgentFace name={m.sender} src={m.avatar ?? null} size={36} />}
      </span>
      <div className="loki-msg-copy">
        {first ? (
          <div className="loki-msg-name">
            {name}
            {time && (
              <time className="loki-msg-time" dateTime={m.at}>
                {time}
              </time>
            )}
          </div>
        ) : (
          <span className="sr-only">{name}: </span>
        )}
        <div className="loki-msg-body loki-slack-text">
          <SlackText text={m.text} />
        </div>
        {m.replies ? (
          <div className="loki-slack-replies">
            {m.replies} {m.replies === 1 ? "reply" : "replies"}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A Slack card's body as the channel shows it (plan 074): the messages before the card's thread, the thread with its
 * replies indented under its first message, and the messages after it, with Slack's day pills and its red New line
 * before the first unread message. The card opens on that line, else on the message the card is about (`newest`).
 */
export function SlackThread({ messages, newest }: { messages: readonly OutsideMessage[]; newest: string }) {
  const plan = planSlackRows(messages);
  const focus = useRef<HTMLDivElement>(null);
  const newAt = plan.findIndex((p) => p.divider);
  const focusAt = newAt >= 0 ? newAt : messages.findIndex((m) => m.id === newest);
  const count = messages.length;
  useEffect(() => {
    if (count) focus.current?.scrollIntoView({ block: "center" });
  }, [count]);
  const more = messages.at(-1)?.more_after === true;
  return (
    <div className="loki-slack-thread">
      {messages.map((m, i) => {
        const p = plan[i];
        return (
          <Fragment key={m.id}>
            {p.day && !p.divider && (
              <div className="loki-msg-day-pill-wrap loki-slack-day">
                <span className="loki-msg-day-pill">{p.day}</span>
              </div>
            )}
            {p.divider && (
              <div className="loki-msg-divider" role="separator" aria-label="New since you last read">
                {p.day && <span className="loki-msg-divider-day">{p.day}</span>}
                <span className="loki-msg-divider-rule" />
                <span className="loki-msg-divider-new">New</span>
              </div>
            )}
            <div ref={i === focusAt ? focus : undefined} className={m.in_thread ? "loki-slack-reply" : undefined}>
              <SlackRow m={m} first={p.first} />
            </div>
          </Fragment>
        );
      })}
      {more && <div className="loki-slack-more">more messages in the channel since</div>}
    </div>
  );
}
