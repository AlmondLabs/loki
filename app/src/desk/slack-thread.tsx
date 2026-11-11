import { Fragment, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type {
  EmojiChoice,
  OutsideMessage,
  OutsideWindow,
  SlackAttachment,
  SlackBlock,
  SlackFile,
  SlackReaction,
  SlackSpan,
} from "../../../core/frame-types.ts";
import { Chip } from "../components";
import { clockLabel, dayLabel, dayPills } from "../shared/thread";
import { scrollWithin } from "../shared/scroll-within";
import { AgentFace } from "./agent-chip";
import { chatImageUrl, openExternal } from "./env";
import { LinkedText, openableHref } from "./mail-html";
import { fileSize } from "./mail-thread";
import type { ThreadControls } from "./outside-card";
import { keyFor, registerActions } from "../shell/keymap";
import { Emoji, EmojiPicker, QUICK_EMOJI, Reactions } from "./slack-reactions";

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

/** What a shared file's chip says after its name: its kind and size, as far as Slack gave them (plan 080). */
export function fileFacts(f: SlackFile): string {
  return [f.kind, f.size === null ? null : fileSize(f.size)].filter(Boolean).join(" · ");
}

/** The largest a picture's preview draws, in pixels, as Slack draws one in a channel. */
const PREVIEW_BOX = { width: 360, height: 240 };

/** A preview's size fitted into PREVIEW_BOX, kept to its shape and never grown, so the row is its height before it loads. */
export function previewSize(p: { width: number; height: number }): { width: number; height: number } {
  const scale = Math.min(1, PREVIEW_BOX.width / p.width, PREVIEW_BOX.height / p.height);
  return { width: Math.round(p.width * scale), height: Math.round(p.height * scale) };
}

/** A shared picture drawn as itself, its name under it; pressing it opens it where it came from, named by `where`. */
function SlackPreview({ f, preview, where }: { f: SlackFile; preview: NonNullable<SlackFile["preview"]>; where: string }) {
  const link = f.link;
  const picture = <img src={chatImageUrl(preview.name)} alt={f.name} loading="lazy" {...previewSize(preview)} />;
  return (
    <figure className="loki-slack-preview">
      {link ? (
        <button type="button" title={`open ${f.name} in ${where}`} onClick={() => openExternal(link)}>
          {picture}
        </button>
      ) : (
        picture
      )}
      <figcaption>{f.name}</figcaption>
    </figure>
  );
}

/**
 * The files shared in a message as chips (plan 080), by name, kind and size, and a picture as itself when its account's
 * Mac saved its thumbnail; pressing one opens it in Slack, which holds its bytes. A file deleted since, or hidden by the workspace's plan, says so and opens nothing.
 * A Jira comment's files ride the same shape (plan 092), so `where` names the place they open: "Slack", or "jira" on a Jira card.
 */
function SlackFiles({ files, where }: { files: readonly SlackFile[]; where: string }) {
  return (
    <div className="loki-slack-files">
      {keyed(files, () => 1).map(([key, f]) => {
        if (f.gone)
          return (
            <Chip key={key} static>
              <span style={{ color: "var(--loki-muted)" }}>{f.gone === "deleted" ? "file deleted" : "file hidden by the workspace's plan"}</span>
            </Chip>
          );
        if (f.preview) return <SlackPreview key={key} f={f} preview={f.preview} where={where} />;
        const facts = fileFacts(f);
        const words = (
          <>
            {f.name} {facts && <span style={{ color: "var(--loki-muted)" }}>{facts}</span>}
          </>
        );
        const link = f.link;
        if (!link)
          return (
            <Chip key={key} static title={`${f.name}: open it from ${where}`}>
              {words}
            </Chip>
          );
        return (
          <Chip key={key} title={`open ${f.name} in ${where}`} onClick={() => openExternal(link)}>
            {words}
          </Chip>
        );
      })}
    </div>
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

/** "1 reply", "3 replies", and so on. */
const replies = (n: number, word = "") => `${String(n)} ${word}${n === 1 ? "reply" : "replies"}`;

/**
 * What a post says of its thread: how many replies are new when some are and the thread can be opened (plan 077,
 * R11), else how many replies it has; null for a post with none.
 */
function repliesLabel(m: OutsideMessage, canOpen: boolean): string | null {
  const fresh = canOpen ? m.new_replies : undefined;
  if (fresh === true) return "new replies";
  if (fresh) return replies(fresh, "new ");
  return m.replies ? replies(m.replies) : null;
}

/**
 * Under a post: its replies as a button that opens its whole thread, saying how many are new when some are; without
 * a way to open it (a Mac on an older loki), how many replies it has.
 */
function SlackReplies({ m, onOpen }: { m: OutsideMessage; onOpen?: () => void }) {
  const label = repliesLabel(m, onOpen !== undefined);
  if (!label) return null;
  if (!onOpen) return <div className="loki-slack-replies">{label}</div>;
  return (
    <button type="button" className="loki-slack-replies loki-slack-open" onClick={onOpen}>
      {label}
    </button>
  );
}

/** One message as the chat draws one: a face and name on the first of a run, its time (and day, when it moved on) beside the name. */
/**
 * What a row can do with reactions (plan 079): open the picker on it, toggle one of its pills, react with one of the
 * person's quick reactions from its hover bar (plan 084), and the picker when open.
 */
interface RowReacting {
  open: () => void;
  toggle: (r: SlackReaction) => void;
  quick: readonly EmojiChoice[];
  pick: (choice: EmojiChoice) => void;
  picker: ReactNode;
}

/** How many of the person's quick reactions a message's hover bar shows, as Slack's does. */
const BAR_QUICK = 3;

/** Slack's add-reaction mark: a face with a plus, drawn in the text's colour. */
function AddReactionMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <path d="M16.5 9.5a7 7 0 1 1-6-6.9" />
      <path d="M7 12.5c.8 1 1.8 1.5 3 1.5s2.2-.5 3-1.5" />
      <circle cx="7.5" cy="8.5" r=".6" fill="currentColor" />
      <circle cx="12.5" cy="8.5" r=".6" fill="currentColor" />
      <path d="M15.5 1.5v5M13 4h5" />
    </svg>
  );
}

/** The bar that shows on the message under the pointer, as Slack's does: the person's quick reactions and the picker. */
function HoverBar({ reacting }: { reacting: RowReacting }) {
  return (
    <div className="loki-slack-hoverbar" role="toolbar" aria-label="react">
      {reacting.quick.slice(0, BAR_QUICK).map((c) => (
        <button key={c.name} type="button" title={`react with :${c.name}:`} onClick={() => reacting.pick(c)}>
          <Emoji emoji={c.emoji} name={c.name} />
        </button>
      ))}
      <button type="button" title={`add a reaction (${keyFor("inbox.react")} on the main message)`} aria-label="add a reaction" onClick={reacting.open}>
        <AddReactionMark />
      </button>
    </div>
  );
}

function SlackRow({
  m,
  first,
  dayNote,
  onOpen,
  reacting,
  jira = false,
}: {
  m: OutsideMessage;
  first: boolean;
  dayNote: string | null;
  onOpen?: () => void;
  reacting?: RowReacting;
  /** A Jira comment (plan 091): it has no reactions or replies, so neither is drawn. */
  jira?: boolean;
}) {
  return (
    <div className="loki-msg loki-slack-row" data-first={first ? "true" : undefined}>
      {reacting && <HoverBar reacting={reacting} />}
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
        {m.slack_files && <SlackFiles files={m.slack_files} where={jira ? "jira" : "Slack"} />}
        {!jira && <Reactions reactions={m.reactions ?? []} onToggle={reacting?.toggle} />}
        {reacting?.picker}
        {!jira && <SlackReplies m={m} onOpen={onOpen} />}
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

/**
 * The red New line before the first message the person has not read (plan 074), with the day when one starts there;
 * a Jira card's thread draws it too (plan 2026-11-10-1451, KTD14).
 */
export function NewLine({ day = null }: { day?: string | null }) {
  return (
    <div className="loki-msg-divider" role="separator" aria-label="New since you last read">
      {day && <span className="loki-msg-divider-day">{day}</span>}
      <span className="loki-msg-divider-rule" />
      <span className="loki-msg-divider-new">New</span>
    </div>
  );
}

/** The day pill and the red New line before a message, as its row plan says. */
function RowMarks({ p }: { p: SlackRowPlan }) {
  if (p.divider) return <NewLine day={p.day} />;
  if (!p.day) return null;
  return (
    <div className="loki-msg-day-pill-wrap loki-slack-day">
      <span className="loki-msg-day-pill">{p.day}</span>
    </div>
  );
}

/**
 * Which messages get the mention look: on a Slack card those that brought it (plan 077), on a Jira card the comments
 * that mention the person (plan 091, Decision 4), since any event brings a Jira card.
 */
const washed = (m: OutsideMessage, jira: boolean) => (jira ? m.mentions_me === true : m.brought === true);

/** A row's classes: indented under its post when it is a reply, and the mention look when `washed` says so. */
const rowClass = (m: OutsideMessage, jira: boolean) =>
  [m.in_thread ? "loki-slack-reply" : "", washed(m, jira) ? "loki-slack-brought" : ""].filter(Boolean).join(" ") || undefined;

/**
 * Where the card's box scrolls: to the focused row when a view opens, unless it `stays`, and, when earlier messages
 * load above what is being read, down by what they added, from wherever the person has scrolled meanwhile, so it
 * stays. A load that brings nothing leaves the box alone. Returns the refs to attach and the call that loads earlier.
 */
function useThreadScroll(opening: string, firstId: string, busy: ThreadControls["busy"] | null, load: (() => void) | null, stays: boolean) {
  const focus = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (stays) return;
    const el = focus.current ?? top.current;
    const box = el?.closest<HTMLElement>("[data-thread-scroll]");
    if (el && box) scrollWithin(box, el, "center");
  }, [opening, stays]);
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

/** How near the bottom the person counts as reading the newest, in pixels: a row's worth less than the very end. */
const AT_BOTTOM_PX = 24;

/** Whether a scroll box is at its bottom, or near enough that the newest message is in view. */
export function atBottom(box: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= AT_BOTTOM_PX;
}

/**
 * Following new messages (plan 090), as Slack does: a message added at the end of the view brings the box down to it
 * when the person was at the bottom already, or when it is their own; anywhere else the box stays where they are
 * reading. Rows that load later are the person's own doing and are not followed. Returns the call that loads later.
 * A Jira card under its ticket (`stays`) opens at the ticket's top, so it counts as not at the bottom until scrolled.
 */
function useFollowNewest(
  top: RefObject<HTMLDivElement | null>,
  opening: string,
  messages: readonly OutsideMessage[],
  controls: ThreadControls | null,
  stays: boolean,
) {
  const last = messages.at(-1);
  const lastId = last?.id ?? "";
  const lastMine = last?.mine === true;
  const busy = controls?.busy ?? null;
  const bottom = useRef(!stays);
  useEffect(() => {
    const box = top.current?.closest<HTMLElement>("[data-thread-scroll]");
    if (!box) return;
    const onScroll = () => {
      bottom.current = atBottom(box);
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => box.removeEventListener("scroll", onScroll);
  }, [top]);
  const loading = useRef(false);
  const seen = useRef({ opening, lastId });
  useLayoutEffect(() => {
    const was = seen.current;
    seen.current = { opening, lastId };
    // While a load is out, rows it brings are the person's; once it is back, failed or not, following resumes.
    if (busy !== null) return;
    const manual = loading.current;
    loading.current = false;
    // A view that just opened is placed by its opening; only a newer last row in the same view is followed.
    if (was.opening !== opening || was.lastId === lastId || manual || !(bottom.current || lastMine)) return;
    const box = top.current?.closest<HTMLElement>("[data-thread-scroll]");
    if (box) box.scrollTop = box.scrollHeight;
  }, [top, opening, lastId, lastMine, busy]);
  return () => {
    loading.current = true;
    controls?.load("after");
  };
}

/**
 * The message ⌘⇧\ reacts to (plan 079): the newest of those that brought the card, else the card's newest message,
 * else the last one shown.
 */
export function mainMessage(messages: readonly OutsideMessage[], newest: string): string | null {
  const brought = messages.filter((m) => m.brought).at(-1);
  if (brought) return brought.id;
  return messages.some((m) => m.id === newest) ? newest : (messages.at(-1)?.id ?? null);
}

/**
 * Reactions on the card (plan 079): which message has the picker open, ⌘⇧\ to open it on the main message while
 * the card can react, and for each row what it can do; nothing where the card cannot react.
 */
function useReacting(messages: readonly OutsideMessage[], newest: string, controls: ThreadControls | null) {
  const [picking, setPicking] = useState<string | null>(null);
  const react = controls?.react;
  const quick = controls?.quick ?? QUICK_EMOJI;
  const main = mainMessage(messages, newest);
  const openMain = useEffectEvent(() => setPicking(main));
  const canReact = !!react;
  useEffect(() => (canReact ? registerActions({ "inbox.react": () => openMain() }) : undefined), [canReact]);
  return (m: OutsideMessage): RowReacting | undefined => {
    if (!react) return undefined;
    const pick = (choice: EmojiChoice) => {
      setPicking(null);
      const mine = m.reactions?.some((r) => r.name === choice.name && r.mine) === true;
      react(m.id, choice, !mine);
    };
    return {
      open: () => setPicking(m.id),
      quick,
      pick,
      toggle: (r) => react(m.id, { name: r.name, emoji: r.emoji ?? { kind: "emoji", text: `:${r.name}:` } }, !r.mine),
      picker: picking === m.id ? <EmojiPicker search={controls.searchEmoji ?? null} quick={quick} onPick={pick} onClose={() => setPicking(null)} /> : null,
    };
  };
}

/**
 * A Slack card's body as Slack shows it: the window around what brought the card (plan 077), in the thread alone with
 * its first message pinned on top, or in the channel or DM with a post's threads indented under it (plan 074), with
 * Slack's day pills, its red New line before the first new message, and the mention look on the messages that brought
 * the card. Buttons load more on either side and open a post's new replies. The card opens on the New line, else on the
 * message the card is about (`newest`); a load keeps what the person is reading where it is.
 *
 * A Jira card's comments are drawn by the same rows (plan 091, Decision 2) with `jira`: without reactions, the hover
 * bar or replies, and with the mention look on the comments that mention the person. Under its ticket the card opens
 * at the ticket's top (plan 089), so `stays` keeps the box where it is when the thread opens.
 */
export function SlackThread({
  messages,
  newest,
  window = null,
  controls = null,
  jira = false,
  stays = false,
}: {
  messages: readonly OutsideMessage[];
  newest: string;
  window?: OutsideWindow | null;
  controls?: ThreadControls | null;
  jira?: boolean;
  stays?: boolean;
}) {
  const pinned = window?.view === "thread" && messages[0]?.id === window.thread_ts ? messages[0] : null;
  const rows = pinned ? messages.slice(1) : messages;
  const plan = planSlackRows(rows);
  const newAt = plan.findIndex((p) => p.divider);
  const focusAt = newAt >= 0 ? newAt : rows.findIndex((m) => m.id === newest);
  const opening = `${window?.view ?? ""}/${window?.thread_ts ?? ""}`;
  const { focus, top, loadEarlier } = useThreadScroll(
    opening,
    rows[0]?.id ?? "",
    controls?.busy ?? null,
    controls ? () => controls.load("before") : null,
    stays,
  );
  const loadLater = useFollowNewest(top, opening, messages, controls, stays);
  const reactingOn = useReacting(messages, newest, jira ? null : controls);
  return (
    <div className="loki-slack-thread" ref={top}>
      {controls?.back && (
        <button type="button" className="loki-slack-load loki-slack-back" onClick={controls.back}>
          back to the conversation
        </button>
      )}
      {pinned && (
        <div className={washed(pinned, jira) ? "loki-slack-brought" : undefined}>
          <SlackRow m={pinned} first dayNote={null} reacting={reactingOn(pinned)} />
        </div>
      )}
      <LoadButton direction="before" window={window} controls={controls} onLoad={loadEarlier} />
      {rows.map((m, i) => (
        <Fragment key={m.id}>
          <RowMarks p={plan[i]} />
          <div ref={i === focusAt ? focus : undefined} className={rowClass(m, jira)}>
            <SlackRow
              m={m}
              first={plan[i].first}
              dayNote={plan[i].dayNote}
              onOpen={controls && !jira && (m.new_replies || m.replies) ? () => controls.openThread(m.id) : undefined}
              reacting={reactingOn(m)}
              jira={jira}
            />
          </div>
        </Fragment>
      ))}
      <LoadButton direction="after" window={window} controls={controls} onLoad={loadLater} />
      {messages.at(-1)?.more_after === true && <div className="loki-slack-more">more messages in the channel since</div>}
    </div>
  );
}
