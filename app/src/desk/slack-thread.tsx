import { Fragment, useEffect, useRef, type ReactNode } from "react";
import type { OutsideMessage, SlackAttachment, SlackBlock, SlackSpan } from "../../../core/frame-types.ts";
import { clockLabel, dayLabel, dayPills } from "../shared/thread";
import { AgentFace } from "./agent-chip";
import { openExternal } from "./env";
import { LinkedText, openableHref } from "./mail-html";

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
  /**
   * The message's day, shown beside its time, when it is not the day of the row above and no pill says so: a reply
   * posted days after its thread began, or the channel going on after such a reply (plan 075).
   */
  dayNote: string | null;
}

/**
 * Each message's day pill, New line and run start, in the card's order (plan 074). Pills come from the channel's own
 * messages only (plan 075): a thread's replies may come days later than the channel messages after it, and pills
 * taken from both would run back in time.
 */
export function planSlackRows(messages: readonly OutsideMessage[], now: number = Date.now()): SlackRowPlan[] {
  const days = dayPills(
    messages.map((m) => (m.in_thread ? {} : m)),
    now,
  );
  const newAt = messages.findIndex((m) => m.unread === true);
  return messages.map((m, i) => {
    const prev = i > 0 ? messages[i - 1] : null;
    const day = days[i];
    const divider = i === newAt;
    const label = dayLabel(m.at, now);
    const dayNote = prev && day === null && label !== null && label !== dayLabel(prev.at, now) ? label : null;
    const gap = prev ? Date.parse(m.at) - Date.parse(prev.at) : Number.NaN;
    const first =
      !prev ||
      day !== null ||
      dayNote !== null ||
      divider ||
      prev.sender !== m.sender ||
      (prev.in_thread === true) !== (m.in_thread === true) ||
      !(gap >= 0 && gap < RUN_GAP_MS);
    return { day, divider, first, dayNote };
  });
}

/**
 * Items keyed by where each starts in the message's words rather than by their place in a list. Each counts at least
 * one character, so no two share a start.
 */
function keyed<T>(items: readonly T[], length: (item: T) => number): Array<[string, T]> {
  let at = 0;
  return items.map((item) => {
    const key = String(at);
    at += Math.max(1, length(item));
    return [key, item];
  });
}

/** One run of a message's words as Slack draws it: styled text, a link to its address, a mention, or an emoji. */
function Span({ s }: { s: SlackSpan }): ReactNode {
  if (s.kind === "mention") return <span className="loki-mention">{s.text}</span>;
  if (s.kind === "emoji") return s.image ? <img className="loki-emoji" src={s.image} alt={s.text} title={s.text} /> : <span title={s.text}>{s.text}</span>;
  if (s.kind === "link") {
    // Only a web or mail address opens; anything else (a slack:// link) is shown as its words.
    if (!openableHref(s.url)) return s.text;
    return (
      <a
        className="loki-mail-link"
        href={s.url}
        title={s.url}
        onClick={(e) => {
          e.preventDefault();
          openExternal(s.url);
        }}
      >
        {s.text}
      </a>
    );
  }
  let out: ReactNode = s.code ? <code className="loki-slack-code">{s.text}</code> : <LinkedText text={s.text} />;
  if (s.strike) out = <s>{out}</s>;
  if (s.italic) out = <em>{out}</em>;
  if (s.bold) out = <strong>{out}</strong>;
  return out;
}

function Spans({ spans }: { spans: readonly SlackSpan[] }) {
  return keyed(spans, (s) => s.text.length).map(([key, s]) => <Span key={key} s={s} />);
}

/** A message's paragraphs: ordinary lines, a quote with Slack's bar, a code block. */
function Blocks({ blocks }: { blocks: readonly SlackBlock[] }) {
  return keyed(blocks, (b) => b.spans.reduce((n, s) => n + s.text.length, 0)).map(([key, b]) => {
    if (b.kind === "code")
      return (
        <pre key={key} className="loki-slack-pre">
          {b.spans.map((s) => s.text).join("")}
        </pre>
      );
    const Tag = b.kind === "quote" ? "blockquote" : "div";
    return (
      <Tag key={key} className={b.kind === "quote" ? "loki-slack-quote" : undefined}>
        <Spans spans={b.spans} />
      </Tag>
    );
  });
}

/** What an app attached to its message (plan 075): a lead line, then a bar in the app's colour beside its title, text and fields. */
function Attachment({ a }: { a: SlackAttachment }) {
  return (
    <>
      {a.pretext && <Blocks blocks={a.pretext} />}
      <div className="loki-slack-attachment" style={a.color ? { borderLeftColor: a.color } : undefined}>
        {a.title && (
          <div className="loki-slack-attachment-title">
            <Spans spans={a.title} />
          </div>
        )}
        {a.body && <Blocks blocks={a.body} />}
        {a.fields && (
          <dl className="loki-slack-fields">
            {a.fields.map((f) => (
              <div key={f.title}>
                <dt>{f.title}</dt>
                <dd>
                  <Blocks blocks={f.value} />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </>
  );
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

/** One message as the chat draws one: a face and name on the first of a run, its time (and day, when it moved on) beside the name. */
function SlackRow({ m, first, dayNote }: { m: OutsideMessage; first: boolean; dayNote: string | null }) {
  const clock = clockLabel(m.at);
  const time = clock && dayNote ? `${dayNote} at ${clock}` : clock;
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
        <div className="loki-msg-body loki-slack-text">{m.body ? <Blocks blocks={m.body} /> : <SlackText text={m.text} />}</div>
        {m.attachments && (
          <div className="loki-msg-body loki-slack-text">
            {keyed(m.attachments, () => 1).map(([key, a]) => (
              <Attachment key={key} a={a} />
            ))}
          </div>
        )}
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
              <SlackRow m={m} first={p.first} dayNote={p.dayNote} />
            </div>
          </Fragment>
        );
      })}
      {more && <div className="loki-slack-more">more messages in the channel since</div>}
    </div>
  );
}
