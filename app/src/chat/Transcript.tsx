import { Fragment, createContext, memo, useContext, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { FileRef, TranscriptRow } from "../../../core/attention/transcript.ts";
import { inTauri } from "../desk/env";
import { fileSize } from "./attachments";
import { Button, IconButton } from "../components";
import { AgentFace } from "../desk/AgentChip";
import { Icon } from "../shared/icons";
import { clockLabel, dayPills } from "../shared/thread";
import { threadId } from "./transcriptWindow";
import { ToolSteps } from "./ToolSteps";
import { isWorkRow, toolRuns } from "../shared/toolSteps";

/** The row shape is core's (the phone renders the same rows); re-exported so chat code keeps one import. */
export type { TranscriptRow };

/**
 * Rows are memoised: parsing markdown for a long thread on every keystroke in
 * the message box made typing lag. A row re-renders only when its own text,
 * its last-ness, or (on the last row alone) the streaming cursor changes. The take-back handler reaches only queued rows,
 * and the host must keep its identity stable (ChatWindow does), or every row re-renders with it.
 * `from` is the first row drawn (the Thread's window, transcriptWindow.ts); rows keep their thread-wide indexes.
 */
export const Transcript = memo(function Transcript({ rows, streaming = false, dim = true, onCancelQueued, people, dividerAt = null, dividerDay = null, widgets, onFrameWidget, onShowDesk, from = 0, arrivedFrom = Infinity, busy = false }: { rows: TranscriptRow[]; streaming?: boolean; dim?: boolean; onCancelQueued?: (row: TranscriptRow) => void; from?: number; /** Rows from this index on came in while the thread was open (useArrivedFrom); they rise in. */ arrivedFrom?: number; /** The agent is working (thinking or streaming): a last run of tools still waiting on its result reads "Running". */ busy?: boolean } & MessageLayout) {
  const first = Math.max(0, Math.min(from, rows.length));
  // Widget rows, by the row they sit before (rows.length: after the last); only in the message layout, only in the window.
  const marks = new Map<number, WidgetMark[]>();
  if (people) for (const w of widgets ?? []) if (w.before >= first) marks.set(w.before, [...(marks.get(w.before) ?? []), w]);
  const shown = first ? rows.slice(first) : rows;
  // Day pills only in the message layout, and only where the messages carry times; then the pills name the day and the New line does not.
  const timed = !!people && shown.some((r) => !!r.at && Number.isFinite(Date.parse(r.at)));
  // The thread as it reads, messages and widget rows together, so each widget row falls in its own day.
  const items = timed ? timeline(rows, marks, first) : null;
  const itemPills = items ? dayPills(items.map((it) => it.row ?? it.mark)) : null;
  // A day that opens on a widget row breaks the run too; the widget row already does.
  let pills: Array<string | null> | null = null;
  if (items && itemPills) {
    pills = rows.map(() => null);
    items.forEach((it, k) => {
      if (it.row) pills![it.i] = itemPills[k];
    });
  }
  const firsts = people ? runStarts(rows, dividerAt, pills, marks, first) : null;
  // A stretch of work (tool calls, background tasks, skills loaded) reads as one line (chat/ToolSteps.tsx); a widget
  // row, a day or the New line ends it.
  const tools = toolRuns(rows, first, (k) => marks.has(k) || !!pills?.[k] || k === dividerAt);
  const widgetRow = (w: WidgetMark) => <WidgetRow key={`w-${w.id}`} mark={w} onFrame={onFrameWidget} onShowDesk={onShowDesk} />;
  const marksAt = (i: number) => marks.get(i)?.map(widgetRow);
  const message = (m: TranscriptRow, i: number) => {
    const last = i === rows.length - 1;
    if (isWorkRow(m)) {
      const end = tools.get(i);
      if (end === undefined) return null; // inside a run, drawn with its first row
      const run = rows.slice(i, end);
      const tail = run[run.length - 1];
      const running = busy && end === rows.length && tail.role === "tool" && !tail.tool?.output;
      return (
        <Fragment key={i}>
          {dividerAt === i && <Divider day={timed ? null : dividerDay} />}
          <ToolSteps rows={run} running={running} arrived={i >= arrivedFrom || undefined} />
        </Fragment>
      );
    }
    return (
      <Fragment key={i}>
        {dividerAt === i && <Divider day={timed ? null : dividerDay} />}
        {/* Only the last row can carry the cursor; told every row, a turn's start and end re-rendered the whole thread. */}
        <Row row={m} last={last} streaming={streaming && last} dim={dim} onCancelQueued={m.queued ? onCancelQueued : undefined} person={people && (m.role === "user" || m.role === "assistant") ? people[m.role] : undefined} first={firsts?.[i] ?? false} arrived={i >= arrivedFrom} />
      </Fragment>
    );
  };
  if (!items || !itemPills)
    return (
      <>
        {shown.map((m, k) => {
          const i = first + k;
          return (
            <Fragment key={i}>
              {marksAt(i)}
              {message(m, i)}
              {i === rows.length - 1 && marksAt(rows.length)}
            </Fragment>
          );
        })}
        {!rows.length && marksAt(0)}
      </>
    );
  // Each day is its own block, so its sticky pill is pushed off by the next day's rather than stacking under it.
  const days: Array<{ label: string | null; start: number; end: number }> = [];
  itemPills.forEach((label, k) => {
    if (label || !days.length) days.push({ label, start: k, end: k + 1 });
    else days[days.length - 1].end = k + 1;
  });
  const draw = (d: { start: number; end: number }) => items.slice(d.start, d.end).map((it) => (it.row ? message(it.row, it.i) : widgetRow(it.mark)));
  // Keyed by the day, not its place: revealing older rows adds to the top day, and must not remount it.
  return (
    <>
      {days.map((d) =>
        d.label ? (
          <section key={`day-${d.label}`} className="loki-msg-day" aria-label={d.label}>
            <div className="loki-msg-day-pill-wrap">
              <span className="loki-msg-day-pill">{d.label}</span>
            </div>
            {draw(d)}
          </section>
        ) : (
          <Fragment key="lead">{draw(d)}</Fragment>
        ),
      )}
    </>
  );
});

type TimelineItem = { i: number; row: TranscriptRow; mark?: undefined } | { i: number; row?: undefined; mark: WidgetMark };

/** The thread in reading order from row `from`: each row's widget marks, then the row; the marks after the last row at the end. */
function timeline(rows: TranscriptRow[], marks: ReadonlyMap<number, WidgetMark[]>, from = 0): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (let i = from; i <= rows.length; i++) {
    for (const mark of marks.get(i) ?? []) out.push({ i, mark });
    if (i < rows.length) out.push({ i, row: rows[i] });
  }
  return out;
}

/**
 * Which rows start a run: a message whose author differs from the last message's, or the first after the
 * divider, a day pill (`pills`, from dayPills) or a widget row (`breaks`, keyed by the row it sits before). Tool and event rows neither start nor break one.
 * From row `from` on (the first drawn starts one); the rows before it are false.
 */
export function runStarts(rows: TranscriptRow[], dividerAt: number | null = null, pills: Array<string | null> | null = null, breaks: ReadonlyMap<number, unknown> | null = null, from = 0): boolean[] {
  const out: boolean[] = new Array<boolean>(rows.length).fill(false);
  let author: TranscriptRow["role"] | null = null;
  for (let i = from; i < rows.length; i++) {
    const m = rows[i];
    if (i === dividerAt || pills?.[i] || breaks?.has(i)) author = null;
    const speaks = m.role === "user" || m.role === "assistant";
    out[i] = speaks && m.role !== author;
    if (speaks) author = m.role;
  }
  return out;
}

/** Who wrote a message, for the message layout: the name over it, and the face beside it (drawn from `face`, or the name). */
export interface Person {
  name: string;
  face?: string | null;
  avatar?: string | null;
}

/**
 * The optional message layout (the phone's, Slack's): with `people`, messages are avatar-led rows — face,
 * bold name, then the body at full width — instead of bubbles. `dividerAt` draws the "New" line before that
 * row, with `dividerDay` ("Today") on its left. When rows carry times (`TranscriptRow.at`), author rows show
 * theirs and a sticky day pill opens each calendar day; the pills then name the day and `dividerDay` is not
 * drawn. Without `people` the transcript is the desktop's, unchanged.
 * The host keeps `people` stable (memo), as with the take-back handler.
 */
export interface MessageLayout {
  people?: { user: Person; assistant: Person };
  dividerAt?: number | null;
  dividerDay?: string | null;
  /** The desk's widget changes among the messages (desk/widgetRows.ts widgetMarks); the host keeps the array stable. */
  widgets?: WidgetMark[];
  /** Choosing a widget row that is still on the desk: open the Desk tab framed on it. */
  onFrameWidget?: (widgetId: string) => void;
  /** Choosing the "N earlier widget changes" summary row: open the Desk tab. */
  onShowDesk?: () => void;
}

/** A widget change in the thread: "friday added Revenue chart" (or "You removed …", "loki added …"), placed before row `before`. */
export interface WidgetMark {
  id: string;
  /** The transcript row it sits before; rows.length puts it after the last. */
  before: number;
  /** ISO 8601, like TranscriptRow.at. */
  at: string;
  /** Who made the change, as the row names them: the agent's name, "You" or "loki". */
  who: string;
  change: "added" | "changed" | "removed";
  title: string;
  widgetId: string;
  /** The widget is no longer on the desk (this row removed it, or a later one did): the row frames nothing. */
  gone: boolean;
  /** Set on the one summary row that stands for this many older changes a thread without times cannot place. */
  earlier?: number;
}

/**
 * A widget row: who, what changed and the widget, with its time. While the widget is on the desk the
 * line is a button that opens the Desk tab framed on it; once it is gone the line says so and does nothing.
 * The summary row (`earlier`) only counts, and opens the Desk tab.
 */
function WidgetRow({ mark: w, onFrame, onShowDesk }: { mark: WidgetMark; onFrame?: (widgetId: string) => void; onShowDesk?: () => void }) {
  if (w.earlier !== undefined) {
    const words = `${w.earlier} earlier widget change${w.earlier === 1 ? "" : "s"}`;
    return (
      <div data-row="widget" className="loki-widget-row">
        <span className="loki-widget-row-icon" aria-hidden>
          <Icon name="widget" size={16} />
        </span>
        {onShowDesk ? (
          <button type="button" className="loki-widget-row-text loki-widget-row-open" title="Show the canvas" onClick={onShowDesk}>
            {words}
          </button>
        ) : (
          <span className="loki-widget-row-text">{words}</span>
        )}
      </div>
    );
  }
  const time = clockLabel(w.at);
  const words = (
    <>
      <span className="loki-widget-row-agent">{w.who}</span> {w.change} <span className="loki-widget-row-title">{w.title}</span>
    </>
  );
  return (
    <div data-row="widget" data-gone={w.gone ? "true" : undefined} className="loki-widget-row">
      <span className="loki-widget-row-icon" aria-hidden>
        <Icon name="widget" size={16} />
      </span>
      {w.gone || !onFrame ? (
        <span className="loki-widget-row-text">
          {words}
          {w.gone && <span>{w.change === "removed" ? " · it is gone from the canvas" : " · since removed from the canvas"}</span>}
        </span>
      ) : (
        <button type="button" className="loki-widget-row-text loki-widget-row-open" title="Show it on the canvas" onClick={() => onFrame(w.widgetId)}>
          {words}
        </button>
      )}
      {time && (
        <time className="loki-msg-time" dateTime={w.at}>
          {time}
        </time>
      )}
    </div>
  );
}

/** The unread boundary: the day on the left, "New" on the right, a hairline between. */
function Divider({ day }: { day: string | null }) {
  return (
    <div className="loki-msg-divider" role="separator" aria-label={day ? `New since you last looked, ${day}` : "New since you last looked"}>
      {day && <span className="loki-msg-divider-day">{day}</span>}
      <span className="loki-msg-divider-rule" />
      <span className="loki-msg-divider-new">New</span>
    </div>
  );
}

/** One row, by role. This is the memo boundary; the shapes below are plain functions rendered inside it. */
/**
 * A long press on a message, where the host wants one (the phone): the host's handler gets the row and opens
 * the message's actions. Without a provider nothing is attached, and the browser keeps its own selection.
 */
export const MessageHold = createContext<((row: TranscriptRow) => void) | null>(null);

/** How long a finger rests on a message before its actions open, as on iOS. */
const HOLD_MS = 500;
/** A finger that moves this far is scrolling or swiping (an Inbox card), not holding. */
const HOLD_SLOP = 8;

/** The long press's handlers for a message's row: a finger resting there opens its actions; a move, a scroll or a lift cancels. */
function useMessageHold(row: TranscriptRow) {
  const onHold = useContext(MessageHold);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const from = useRef({ x: 0, y: 0 });
  if (!onHold || !row.text) return {};
  const end = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    "data-hold": "",
    onPointerDown: (e: PointerEvent) => {
      if (e.pointerType === "mouse" || (e.target as Element).closest("button, a, summary, input, textarea")) return;
      end();
      from.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        timer.current = null;
        onHold(row);
      }, HOLD_MS);
    },
    onPointerMove: (e: PointerEvent) => {
      if (timer.current && Math.hypot(e.clientX - from.current.x, e.clientY - from.current.y) > HOLD_SLOP) end();
    },
    onPointerUp: end,
    onPointerCancel: end,
    onPointerLeave: end,
    // Android's long press (and a right-click) arrives as a context menu: the message's actions, not the browser's.
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      end();
      onHold(row);
    },
  };
}

const Row = memo(function Row({ row: m, last, streaming, dim, onCancelQueued, person, first = false, arrived = false }: { row: TranscriptRow; last: boolean; streaming: boolean; dim: boolean; onCancelQueued?: (row: TranscriptRow) => void; person?: Person; first?: boolean; /** Came in while the thread was open. */ arrived?: boolean }) {
  // A row that came in while the thread was open carries data-arrived, and rises in (the phone's chat CSS).
  const a = arrived || undefined;
  if (m.role === "event") return <EventRow row={m} arrived={a} />;
  if (person) return <Message row={m} last={last} streaming={streaming} person={person} first={first} onCancelQueued={onCancelQueued} arrived={a} />;
  return <Bubble row={m} last={last} streaming={streaming} dim={dim} onCancelQueued={onCancelQueued} arrived={a} />;
});

/**
 * A message in the avatar-led layout: the face and bold name at the start of a run. Under every message,
 * yours and the agent's, a quiet row: its copy button (as markdown; faint on the desktop until the row is
 * hovered, always there on the phone), then its time. A message still streaming shows its time and gets
 * the button when it is done; one with no known time shows none. Where a host provides MessageHold (the phone), a long press
 * on the message opens its actions instead of the browser's text selection.
 */
function Message({ row: m, last, streaming, person, first, onCancelQueued, arrived }: { row: TranscriptRow; last: boolean; streaming: boolean; person: Person; first: boolean; onCancelQueued?: (row: TranscriptRow) => void; arrived?: true }) {
  const time = clockLabel(m.at);
  const hold = useMessageHold(m);
  // Copy waits for a streaming reply to finish; its time is there from the start.
  const copyable = !!m.text && !(last && streaming);
  return (
    <div data-row={m.role} data-queued={m.queued ? "true" : undefined} data-first={first ? "true" : undefined} data-arrived={arrived} className="loki-msg" {...hold}>
      <span className="loki-msg-face" aria-hidden>
        {first && <AgentFace name={person.face ?? person.name} src={person.avatar ?? null} size={36} />}
      </span>
      <div className="loki-msg-copy">
        {first && <div className="loki-msg-name">{person.name}</div>}
        {!first && <span className="sr-only">{person.name}: </span>}
        <div className="loki-msg-body">{m.role === "assistant" ? <AssistantBody row={m} cursor={last && streaming} /> : <UserBody row={m} />}</div>
        {m.queued && (
          <Button bare size="sm" tone="brass" onClick={() => onCancelQueued?.(m)} disabled={!onCancelQueued} className="loki-msg-queued">
            queued · sends when this turn ends{onCancelQueued ? " · take back" : ""}
          </Button>
        )}
        {(copyable || time) && (
          <div className="loki-msg-actions">
            {copyable && <CopyMarkdown text={m.text} className="loki-msg-action" />}
            {time && (
              <time className="loki-msg-time" dateTime={m.at}>
                {time}
              </time>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function EventRow({ row: m, arrived }: { row: TranscriptRow; arrived?: true }) {
  return (
    <details data-row="event" data-arrived={arrived} className="loki-event-row">
      <summary className="loki-event-summary" style={{ cursor: m.detail ? "pointer" : "default", listStyle: m.detail ? "disclosure-closed" : "none" }}>
        ⟳ {m.text}
        {m.summary && <span className="loki-event-aside">{m.summary}</span>}
      </summary>
      {m.detail && <pre className="loki-event-detail">{m.detail}</pre>}
    </details>
  );
}

/** A user or assistant message: the bubble, and under a queued one the take-back button. */
function Bubble({ row: m, last, streaming, dim, onCancelQueued, arrived }: { row: TranscriptRow; last: boolean; streaming: boolean; dim: boolean; onCancelQueued?: (row: TranscriptRow) => void; arrived?: true }) {
  return (
    <div data-row={m.role} data-queued={m.queued ? "true" : undefined} data-arrived={arrived} style={{ display: "flex", flexDirection: "column", alignItems: m.role === "user" ? "flex-end" : "flex-start", margin: "8px 0" }}>
      <div className="loki-bubble" data-role={m.role}>
      <div
        style={{
          maxWidth: "78%",
          minWidth: 0,
          overflowWrap: "anywhere",
          padding: "9px 13px",
          borderRadius: "var(--loki-radius-lg)",
          background: m.role === "user" ? "var(--loki-user-bubble)" : "var(--loki-bubble)",
          // Typed mid-turn and not sent yet: quieter, with a dashed edge, until the turn ends.
          border: m.queued ? "1px dashed var(--loki-accent)" : undefined,
          opacity: m.queued ? 0.7 : !dim || last || m.role === "user" ? 1 : 0.85,
          color: "var(--loki-fg)",
        }}
      >
        {m.role === "assistant" ? <AssistantBody row={m} cursor={last && streaming} /> : <UserBody row={m} />}
      </div>
      {m.text && !(last && streaming) && <CopyMarkdown text={m.text} />}
      </div>
      {m.queued && (
        <Button bare size="sm" tone="brass" onClick={() => onCancelQueued?.(m)} disabled={!onCancelQueued} style={{ marginTop: 4 }}>
          queued · sends when this turn ends{onCancelQueued ? " · take back" : ""}
        </Button>
      )}
    </div>
  );
}

/** The bubble's text as it was written — markdown, not the rendering — onto the clipboard. Says "copied" for a beat. */
function CopyMarkdown({ text, className = "loki-bubble-copy" }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // the clipboard refused (no permission in this context): the label stays, nothing else to say
    }
  };
  return (
    <IconButton size={24} className={className} label={copied ? "copied" : "copy as markdown"} data-copied={copied ? "true" : undefined} onClick={() => void copy()}>
      {copied ? (
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 8.5l3 3 7-7" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden>
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
          <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
        </svg>
      )}
    </IconButton>
  );
}

/**
 * Where the rows that came in while you watched begin: the count there was when this thread was first drawn
 * with its rows. The history, and older rows revealed by scrolling up, sit before it; a new first row is a new
 * thread, which starts again. Until the rows load, nothing has arrived.
 */
export function useArrivedFrom(rows: TranscriptRow[] | undefined): number {
  const id = rows ? threadId(rows) : null;
  const [opened, setOpened] = useState<{ id: string | null; count: number }>({ id, count: rows?.length ?? Infinity });
  if (opened.id !== id) setOpened({ id, count: rows?.length ?? Infinity });
  return opened.id === id ? opened.count : Infinity;
}

/** A node of the rendered markdown (hast), as much of it as wrapping words needs. */
type HastNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] };

/**
 * While a reply streams, each word is its own span, so a word that arrives mounts and fades in (the phone's
 * chat CSS) while the words before it stay put: spans keep their place, so only the new ones are new. Code
 * keeps its text whole. Once the turn ends the reply renders as plain text again.
 */
export function rehypeWords() {
  const wrap = (node: HastNode, inCode: boolean) => {
    if (!node.children) return;
    const code = inCode || node.tagName === "pre" || node.tagName === "code";
    node.children = node.children.flatMap((child): HastNode[] => {
      if (child.type !== "text" || code) {
        wrap(child, code);
        return [child];
      }
      const words = child.value?.match(/\S+\s*|\s+/g) ?? [];
      return words.map((w) => (/^\s+$/.test(w) ? { type: "text", value: w } : { type: "element", tagName: "span", properties: { className: ["loki-word"] }, children: [{ type: "text", value: w }] }));
    });
  };
  return (tree: HastNode) => wrap(tree, false);
}
const LIVE_PLUGINS = [rehypeWords];

function AssistantBody({ row: m, cursor }: { row: TranscriptRow; cursor: boolean }) {
  return (
    <div className={cursor ? "loki-md loki-md--live" : "loki-md"}>
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={cursor ? LIVE_PLUGINS : undefined}>
        {m.text}
      </Markdown>
      {cursor && <span style={{ opacity: 0.6 }}>▍</span>}
    </div>
  );
}

/** A file the message carried: its name and size; in the desktop app a click shows it in its folder. */
function FileChip({ file }: { file: FileRef }) {
  const body = (
    <>
      <Icon name="file" size={16} />
      <span className="loki-file-chip-name">{file.name}</span>
      {file.size !== undefined && <span className="loki-file-chip-size">{fileSize(file.size)}</span>}
    </>
  );
  if (!inTauri) return <span className="loki-file-chip" title={file.path}>{body}</span>;
  return (
    <button
      type="button"
      className="loki-file-chip"
      title={`Show ${file.path} in its folder`}
      onClick={() => void import("@tauri-apps/plugin-opener").then(({ revealItemInDir }) => revealItemInDir(file.path)).catch((err) => console.warn("loki: reveal file", err))}
    >
      {body}
    </button>
  );
}

function UserBody({ row: m }: { row: TranscriptRow }) {
  return (
    <>
      {m.images && m.images.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: m.text ? 8 : 0 }}>
          {m.images.map((src, k) => (
            <img key={k} src={src} alt="" style={{ maxWidth: 220, maxHeight: 160, borderRadius: "var(--loki-radius-sm)", border: "1px solid var(--loki-border)", display: "block" }} />
          ))}
        </div>
      )}
      {m.files && m.files.length > 0 && (
        <div className="loki-bubble-files" style={{ marginBottom: m.text ? 8 : 0 }}>
          {m.files.map((f) => (
            <FileChip key={f.path} file={f} />
          ))}
        </div>
      )}
      {/* Your own words get the same markdown as the agent's: pasted prompts and skill text are full of it. */}
      {m.text && (
        <div className="loki-md">
          <Markdown remarkPlugins={[remarkGfm]}>{m.text}</Markdown>
        </div>
      )}
    </>
  );
}
