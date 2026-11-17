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
import { SmilePlusIcon } from "lucide-react";
import { Glyph } from "../shared/icons";

const RUN_GAP_MS = 5 * 60_000;

export interface SlackRowPlan {
  day: string | null;
  divider: boolean;
  first: boolean;
  dayNote: string | null;
}

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

function keyed<T>(items: readonly T[], length: (item: T) => number): Array<[string, T]> {
  let at = 0;
  return items.map((item) => {
    const key = String(at);
    at += Math.max(1, length(item));
    return [key, item];
  });
}

function Span({ s }: { s: SlackSpan }): ReactNode {
  if (s.kind === "mention") return <span className="loki-mention">{s.text}</span>;
  if (s.kind === "emoji") return s.image ? <img className="loki-emoji" src={s.image} alt={s.text} title={s.text} /> : <span title={s.text}>{s.text}</span>;
  let out: ReactNode;
  if (s.kind === "link") {
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

export function Blocks({ blocks }: { blocks: readonly SlackBlock[] }) {
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

export function AppAttachment({ a }: { a: SlackAttachment }) {
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

export function fileFacts(f: SlackFile): string {
  return [f.kind, f.size === null ? null : fileSize(f.size)].filter(Boolean).join(" · ");
}

const PREVIEW_BOX = { width: 360, height: 240 };

export function previewSize(p: { width: number; height: number }): { width: number; height: number } {
  const scale = Math.min(1, PREVIEW_BOX.width / p.width, PREVIEW_BOX.height / p.height);
  return { width: Math.round(p.width * scale), height: Math.round(p.height * scale) };
}

function SlackPreview({ f, preview, where }: { f: SlackFile; preview: NonNullable<SlackFile["preview"]>; where: string }) {
  const link = f.link;
  const picture = <img src={chatImageUrl(preview.name)} alt={f.name} loading="lazy" {...previewSize(preview)} />;
  return (
    <figure className="loki-slack-preview">
      {link ? (
        <button type="button" title={`Open ${f.name} in ${where}`} onClick={() => openExternal(link)}>
          {picture}
        </button>
      ) : (
        picture
      )}
      <figcaption>{f.name}</figcaption>
    </figure>
  );
}

export function SlackFiles({ files, where }: { files: readonly SlackFile[]; where: string }) {
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
          <Chip key={key} title={`Open ${f.name} in ${where}`} onClick={() => openExternal(link)}>
            {words}
          </Chip>
        );
      })}
    </div>
  );
}

const BROADCAST = /(@(?:channel|here|everyone))\b/;

function SlackText({ text }: { text: string }): ReactNode {
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

const replies = (n: number, word = "") => `${String(n)} ${word}${n === 1 ? "reply" : "replies"}`;

function repliesLabel(m: OutsideMessage, canOpen: boolean): string | null {
  const fresh = canOpen ? m.new_replies : undefined;
  if (fresh === true) return "new replies";
  if (fresh) return replies(fresh, "new ");
  return m.replies ? replies(m.replies) : null;
}

export function SlackReplies({ m, onOpen }: { m: OutsideMessage; onOpen?: () => void }) {
  const label = repliesLabel(m, onOpen !== undefined);
  if (!label) return null;
  if (!onOpen) return <div className="loki-slack-replies">{label}</div>;
  return (
    <button type="button" className="loki-slack-replies loki-slack-open" onClick={onOpen}>
      {label}
    </button>
  );
}

export interface RowReacting {
  open: () => void;
  toggle: (r: SlackReaction) => void;
  quick: readonly EmojiChoice[];
  pick: (choice: EmojiChoice) => void;
  picker: ReactNode;
}

const BAR_QUICK = 3;

function AddReactionMark() {
  return <Glyph icon={SmilePlusIcon} size={18} />;
}

export function HoverBar({ reacting }: { reacting: RowReacting }) {
  return (
    <div className="loki-slack-hoverbar" role="toolbar" aria-label="React">
      {reacting.quick.slice(0, BAR_QUICK).map((c) => (
        <button key={c.name} type="button" title={`React with :${c.name}:`} onClick={() => reacting.pick(c)}>
          <Emoji emoji={c.emoji} name={c.name} />
        </button>
      ))}
      <button type="button" title={`Add a reaction (${keyFor("inbox.react")} on the main message)`} aria-label="Add a reaction" onClick={reacting.open}>
        <AddReactionMark />
      </button>
    </div>
  );
}

export interface SlackRowAt {
  first: boolean;
  dayNote: string | null;
  onOpen?: () => void;
  reacting?: RowReacting;
  jira: boolean;
}

const defaultRow = (m: OutsideMessage, at: SlackRowAt) => <SlackRow m={m} {...at} />;

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
              <AppAttachment key={key} a={a} />
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

export function loadLabel(direction: "before" | "after", more: number | boolean, busy: boolean): string {
  if (busy) return "loading…";
  if (typeof more === "number") return `${String(more)} ${direction === "before" ? "earlier" : "later"} ${more === 1 ? "reply" : "replies"}`;
  return direction === "before" ? "load earlier" : "load later";
}

const hasMore = (more: number | boolean) => (typeof more === "number" ? more > 0 : more);

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

export function NewLine({ day = null }: { day?: string | null }) {
  return (
    <div className="loki-msg-divider" role="separator" aria-label="New since you last read">
      {day && <span className="loki-msg-divider-day">{day}</span>}
      <span className="loki-msg-divider-rule" />
      <span className="loki-msg-divider-new">New</span>
    </div>
  );
}

function RowMarks({ p }: { p: SlackRowPlan }) {
  if (p.divider) return <NewLine day={p.day} />;
  if (!p.day) return null;
  return (
    <div className="loki-msg-day-pill-wrap loki-slack-day">
      <span className="loki-msg-day-pill">{p.day}</span>
    </div>
  );
}

const washed = (m: OutsideMessage, jira: boolean) => (jira ? m.mentions_me === true : m.brought === true);

const rowClass = (m: OutsideMessage, jira: boolean) =>
  [m.in_thread ? "loki-slack-reply" : "", washed(m, jira) ? "loki-slack-brought" : ""].filter(Boolean).join(" ") || undefined;

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

const AT_BOTTOM_PX = 24;

export function atBottom(box: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= AT_BOTTOM_PX;
}

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
    if (busy !== null) return;
    const manual = loading.current;
    loading.current = false;
    if (was.opening !== opening || was.lastId === lastId || manual || !(bottom.current || lastMine)) return;
    const box = top.current?.closest<HTMLElement>("[data-thread-scroll]");
    if (box) box.scrollTop = box.scrollHeight;
  }, [top, opening, lastId, lastMine, busy]);
  return () => {
    loading.current = true;
    controls?.load("after");
  };
}

export function mainMessage(messages: readonly OutsideMessage[], newest: string): string | null {
  const brought = messages.filter((m) => m.brought).at(-1);
  if (brought) return brought.id;
  return messages.some((m) => m.id === newest) ? newest : (messages.at(-1)?.id ?? null);
}

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

export function SlackThread({
  messages,
  newest,
  window = null,
  controls = null,
  jira = false,
  stays = false,
  row = defaultRow,
}: {
  messages: readonly OutsideMessage[];
  newest: string;
  window?: OutsideWindow | null;
  controls?: ThreadControls | null;
  jira?: boolean;
  stays?: boolean;
  row?: (m: OutsideMessage, at: SlackRowAt) => ReactNode;
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
          Back to the Conversation
        </button>
      )}
      {pinned && (
        <div className={washed(pinned, jira) ? "loki-slack-brought" : undefined}>
          {row(pinned, { first: true, dayNote: null, reacting: reactingOn(pinned), jira })}
        </div>
      )}
      <LoadButton direction="before" window={window} controls={controls} onLoad={loadEarlier} />
      {rows.map((m, i) => (
        <Fragment key={m.id}>
          <RowMarks p={plan[i]} />
          <div ref={i === focusAt ? focus : undefined} className={rowClass(m, jira)}>
            {row(m, {
              first: plan[i].first,
              dayNote: plan[i].dayNote,
              onOpen: controls && !jira && (m.new_replies || m.replies) ? () => controls.openThread(m.id) : undefined,
              reacting: reactingOn(m),
              jira,
            })}
          </div>
        </Fragment>
      ))}
      <LoadButton direction="after" window={window} controls={controls} onLoad={loadLater} />
      {messages.at(-1)?.more_after === true && <div className="loki-slack-more">More messages in the channel since</div>}
    </div>
  );
}
