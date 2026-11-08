import { Fragment, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import type { OutsideMessage, OutsideWindow, SlackAttachment, SlackBlock, SlackSpan } from "../../../core/frame-types.ts";
import { clockLabel, dayLabel, dayPills } from "../shared/thread";
import { scrollWithin } from "../shared/scroll-within";
import { AgentFace } from "./agent-chip";
import { openExternal } from "./env";
import { LinkedText, openableHref } from "./mail-html";
import type { ThreadControls } from "./outside-card";

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
  let out: ReactNode;
  if (s.kind === "link") {
    // Only a web or mail address opens; anything else (a slack:// link) is shown as its words.
    out = !openableHref(s.url) ? (
      s.text
    ) : (
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
  } else out = s.code ? <code className="loki-slack-code">{s.text}</code> : <LinkedText text={s.text} />;
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

/** The name and time on the first message of a run; later ones in the run keep the name for a screen reader only. */
function SlackHead({ m, first, dayNote }: { m: OutsideMessage; first: boolean; dayNote: string | null }) {
  const name = m.mine ? "you" : m.sender;
  if (!first) return <span className="sr-only">{name}: </span>;
  const clock = clockLabel(m.at);
  const time = clock && dayNote ? `${dayNote} at ${clock}` : clock;
  return (
    <div className="loki-msg-name">
      {name}
      {time && (
        <time className="loki-msg-time" dateTime={m.at}>
          {time}
        </time>
      )}
    </div>
  );
}

/** Under a post: its new replies as a button that opens its thread (plan 077, R11), else how many replies it has. */
function SlackReplies({ m, onOpen }: { m: OutsideMessage; onOpen?: () => void }) {
  if (m.new_replies && onOpen) {
    const count = m.new_replies === true ? "new replies" : `${String(m.new_replies)} new ${m.new_replies === 1 ? "reply" : "replies"}`;
    return (
      <button type="button" className="loki-slack-replies loki-slack-open" onClick={onOpen}>
        {count}
      </button>
    );
  }
  if (!m.replies) return null;
  return (
    <div className="loki-slack-replies">
      {m.replies} {m.replies === 1 ? "reply" : "replies"}
    </div>
  );
}

/** One message as the chat draws one: a face and name on the first of a run, its time (and day, when it moved on) beside the name. */
function SlackRow({ m, first, dayNote, onOpen }: { m: OutsideMessage; first: boolean; dayNote: string | null; onOpen?: () => void }) {
  return (
    <div className="loki-msg" data-first={first ? "true" : undefined}>
      <span className="loki-msg-face" aria-hidden>
        {first && <AgentFace name={m.sender} src={m.avatar ?? null} size={36} />}
      </span>
      <div className="loki-msg-copy">
        <SlackHead m={m} first={first} dayNote={dayNote} />
        <div className="loki-msg-body loki-slack-text">{m.body ? <Blocks blocks={m.body} /> : <SlackText text={m.text} />}</div>
        {m.attachments && (
          <div className="loki-msg-body loki-slack-text">
            {keyed(m.attachments, () => 1).map(([key, a]) => (
              <Attachment key={key} a={a} />
            ))}
          </div>
        )}
        <SlackReplies m={m} onOpen={onOpen} />
      </div>
    </div>
  );
}

/** What a load button says: a thread's count of replies on that side, else "load earlier" or "load later" (plan 077, R3). */
export function loadLabel(direction: "before" | "after", more: number | boolean, busy: boolean): string {
  if (busy) return "loading…";
  if (typeof more === "number") return `${String(more)} ${direction === "before" ? "earlier" : "later"} ${more === 1 ? "reply" : "replies"}`;
  return direction === "before" ? "load earlier" : "load later";
}

/** Whether there is more on a side to load (R4). */
const hasMore = (more: number | boolean) => (typeof more === "number" ? more > 0 : more);

/** A button that loads more on one side of the window, drawn only when the window has more there (plan 077, R3, R4). */
function LoadButton({
  direction,
  window,
  controls,
  onLoad,
}: {
  direction: "before" | "after";
  window: OutsideWindow | null;
  controls: ThreadControls | null;
  onLoad: () => void;
}) {
  const more = direction === "before" ? window?.more_before : window?.more_after;
  if (!controls || more === undefined || !hasMore(more)) return null;
  return (
    <button type="button" className="loki-slack-load" disabled={controls.busy !== null} onClick={onLoad}>
      {loadLabel(direction, more, controls.busy === direction)}
    </button>
  );
}

/** The day pill and the red New line before a message, as its row plan says. */
function RowMarks({ p }: { p: SlackRowPlan }) {
  if (p.divider)
    return (
      <div className="loki-msg-divider" role="separator" aria-label="New since you last read">
        {p.day && <span className="loki-msg-divider-day">{p.day}</span>}
        <span className="loki-msg-divider-rule" />
        <span className="loki-msg-divider-new">New</span>
      </div>
    );
  if (!p.day) return null;
  return (
    <div className="loki-msg-day-pill-wrap loki-slack-day">
      <span className="loki-msg-day-pill">{p.day}</span>
    </div>
  );
}

/** A row's classes: indented under its post when it is a reply, and the mention look when it brought the card. */
const rowClass = (m: OutsideMessage) => [m.in_thread ? "loki-slack-reply" : "", m.brought ? "loki-slack-brought" : ""].filter(Boolean).join(" ") || undefined;

/**
 * Where the card's box scrolls: to the focused row when a view opens, and, when earlier messages load above what is
 * being read, down by what they added, from wherever the person has scrolled meanwhile, so it stays. A load that brings
 * nothing leaves the box alone. Returns the refs to attach and the call that loads earlier.
 */
function useThreadScroll(opening: string, firstId: string, busy: ThreadControls["busy"] | null, load: (() => void) | null) {
  const focus = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = focus.current ?? top.current;
    const box = el?.closest<HTMLElement>("[data-thread-scroll]");
    if (el && box) scrollWithin(box, el, "center");
  }, [opening]);
  const kept = useRef<{ box: HTMLElement; height: number } | null>(null);
  useLayoutEffect(() => {
    const k = kept.current;
    kept.current = null;
    if (k) k.box.scrollTop += k.box.scrollHeight - k.height;
  }, [firstId]);
  useLayoutEffect(() => {
    if (busy === null) kept.current = null;
  }, [busy]);
  const loadEarlier = () => {
    const box = top.current?.closest<HTMLElement>("[data-thread-scroll]");
    if (box) kept.current = { box, height: box.scrollHeight };
    load?.();
  };
  return { focus, top, loadEarlier };
}

/**
 * A Slack card's body as Slack shows it: the window around what brought the card (plan 077), in the thread alone with
 * its first message pinned on top, or in the channel or DM with a post's threads indented under it (plan 074), with
 * Slack's day pills, its red New line before the first new message, and the mention look on the messages that brought
 * the card. Buttons load more on either side and open a post's new replies. The card opens on the New line, else on the
 * message the card is about (`newest`); a load keeps what the person is reading where it is.
 */
export function SlackThread({
  messages,
  newest,
  window = null,
  controls = null,
}: {
  messages: readonly OutsideMessage[];
  newest: string;
  window?: OutsideWindow | null;
  controls?: ThreadControls | null;
}) {
  const pinned = window?.view === "thread" && messages[0]?.id === window.thread_ts ? messages[0] : null;
  const rows = pinned ? messages.slice(1) : messages;
  const plan = planSlackRows(rows);
  const newAt = plan.findIndex((p) => p.divider);
  const focusAt = newAt >= 0 ? newAt : rows.findIndex((m) => m.id === newest);
  const opening = `${window?.view ?? ""}/${window?.thread_ts ?? ""}`;
  const { focus, top, loadEarlier } = useThreadScroll(opening, rows[0]?.id ?? "", controls?.busy ?? null, controls ? () => controls.load("before") : null);
  return (
    <div className="loki-slack-thread" ref={top}>
      {controls?.back && (
        <button type="button" className="loki-slack-load loki-slack-back" onClick={controls.back}>
          back to the conversation
        </button>
      )}
      {pinned && (
        <div className={pinned.brought ? "loki-slack-brought" : undefined}>
          <SlackRow m={pinned} first dayNote={null} />
        </div>
      )}
      <LoadButton direction="before" window={window} controls={controls} onLoad={loadEarlier} />
      {rows.map((m, i) => (
        <Fragment key={m.id}>
          <RowMarks p={plan[i]} />
          <div ref={i === focusAt ? focus : undefined} className={rowClass(m)}>
            <SlackRow m={m} first={plan[i].first} dayNote={plan[i].dayNote} onOpen={controls && m.new_replies ? () => controls.openThread(m.id) : undefined} />
          </div>
        </Fragment>
      ))}
      <LoadButton direction="after" window={window} controls={controls} onLoad={() => controls?.load("after")} />
      {messages.at(-1)?.more_after === true && <div className="loki-slack-more">more messages in the channel since</div>}
    </div>
  );
}
