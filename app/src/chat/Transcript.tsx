import { Fragment, memo, useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import { Button, IconButton } from "../components";
import { AgentFace } from "../desk/AgentChip";
import { clockLabel, dayPills } from "../shared/thread";

/** The row shape is core's (the phone renders the same rows); re-exported so chat code keeps one import. */
export type { TranscriptRow };

/**
 * Rows are memoised: parsing markdown for a long thread on every keystroke in
 * the message box made typing lag. A row re-renders only when its own text,
 * its last-ness, or the streaming cursor changes. The take-back handler reaches only queued rows,
 * and the host must keep its identity stable (ChatWindow does), or every row re-renders with it.
 */
export const Transcript = memo(function Transcript({ rows, streaming = false, dim = true, onCancelQueued, people, dividerAt = null, dividerDay = null, toolbar = false }: { rows: TranscriptRow[]; streaming?: boolean; dim?: boolean; onCancelQueued?: (row: TranscriptRow) => void } & MessageLayout) {
  // Day pills only in the message layout, and only where rows carry times; then the pills name the day and the New line does not.
  const pills = people ? dayPills(rows) : null;
  const timed = pills?.some(Boolean) ?? false;
  const firsts = people ? runStarts(rows, dividerAt, pills) : null;
  const row = (m: TranscriptRow, i: number) => (
    <Fragment key={i}>
      {dividerAt === i && <Divider day={timed ? null : dividerDay} />}
      <Row row={m} last={i === rows.length - 1} streaming={streaming} dim={dim} onCancelQueued={m.queued ? onCancelQueued : undefined} person={people && (m.role === "user" || m.role === "assistant") ? people[m.role] : undefined} first={firsts?.[i] ?? false} toolbar={toolbar} />
    </Fragment>
  );
  if (!timed || !pills) return <>{rows.map(row)}</>;
  // Each day is its own block, so its sticky pill is pushed off by the next day's rather than stacking under it.
  const days: Array<{ label: string | null; start: number; end: number }> = [];
  pills.forEach((label, i) => {
    if (label || !days.length) days.push({ label, start: i, end: i + 1 });
    else days[days.length - 1].end = i + 1;
  });
  return (
    <>
      {days.map((d) =>
        d.label ? (
          <section key={`day-${d.start}`} className="loki-msg-day" aria-label={d.label}>
            <div className="loki-msg-day-pill-wrap">
              <span className="loki-msg-day-pill">{d.label}</span>
            </div>
            {rows.slice(d.start, d.end).map((m, k) => row(m, d.start + k))}
          </section>
        ) : (
          <Fragment key={`lead-${d.start}`}>{rows.slice(d.start, d.end).map((m, k) => row(m, d.start + k))}</Fragment>
        ),
      )}
    </>
  );
});

/**
 * Which rows start a run: a message whose author differs from the last message's, or the first after the
 * divider or a day pill (`pills`, from dayPills). Tool and event rows neither start nor break one.
 */
export function runStarts(rows: TranscriptRow[], dividerAt: number | null = null, pills: Array<string | null> | null = null): boolean[] {
  const out: boolean[] = [];
  let author: TranscriptRow["role"] | null = null;
  rows.forEach((m, i) => {
    if (i === dividerAt || pills?.[i]) author = null;
    const speaks = m.role === "user" || m.role === "assistant";
    out.push(speaks && m.role !== author);
    if (speaks) author = m.role;
  });
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
  /** The hover action bar on each message (the desktop's Messages tab); the phone leaves it off. */
  toolbar?: boolean;
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
const Row = memo(function Row({ row: m, last, streaming, dim, onCancelQueued, person, first = false, toolbar = false }: { row: TranscriptRow; last: boolean; streaming: boolean; dim: boolean; onCancelQueued?: (row: TranscriptRow) => void; person?: Person; first?: boolean; toolbar?: boolean }) {
  if (m.role === "tool") return <ToolRow row={m} />;
  if (m.role === "event") return <EventRow row={m} />;
  if (person) return <Message row={m} last={last} streaming={streaming} person={person} first={first} onCancelQueued={onCancelQueued} toolbar={toolbar} />;
  return <Bubble row={m} last={last} streaming={streaming} dim={dim} onCancelQueued={onCancelQueued} />;
});

/**
 * A message in the avatar-led layout: the face and bold name at the start of a run, with the message's
 * quiet time after the name; later messages in the run keep their time in the face's column, shown on
 * hover (desktop). A message with no known time shows none. With `toolbar`, hovering shows Slack's small
 * action bar holding what loki already does to a message: copy it as markdown.
 */
function Message({ row: m, last, streaming, person, first, onCancelQueued, toolbar }: { row: TranscriptRow; last: boolean; streaming: boolean; person: Person; first: boolean; onCancelQueued?: (row: TranscriptRow) => void; toolbar?: boolean }) {
  const time = clockLabel(m.at);
  return (
    <div data-row={m.role} data-queued={m.queued ? "true" : undefined} data-first={first ? "true" : undefined} className="loki-msg">
      <span className="loki-msg-face" aria-hidden>
        {first && <AgentFace name={person.face ?? person.name} src={person.avatar ?? null} size={36} />}
        {!first && time && <span className="loki-msg-gutter-time">{time}</span>}
      </span>
      <div className="loki-msg-copy">
        {first && (
          <div className="loki-msg-name">
            {person.name}
            {time && (
              <time className="loki-msg-time" dateTime={m.at}>
                {time}
              </time>
            )}
          </div>
        )}
        {!first && <span className="sr-only">{person.name}: </span>}
        <div className="loki-msg-body">{m.role === "assistant" ? <AssistantBody row={m} cursor={last && streaming} /> : <UserBody row={m} />}</div>
        {m.queued && (
          <Button bare size="sm" tone="brass" onClick={() => onCancelQueued?.(m)} disabled={!onCancelQueued} className="loki-msg-queued">
            queued · sends when this turn ends{onCancelQueued ? " · take back" : ""}
          </Button>
        )}
      </div>
      {toolbar && m.text && !(last && streaming) && (
        <div className="loki-msg-toolbar" role="toolbar" aria-label="Message actions">
          <CopyMarkdown text={m.text} className="loki-msg-action" />
        </div>
      )}
    </div>
  );
}

/** A tool the agent ran: one quiet line (chat.css; the phone sets it in its sans meta). */
function ToolRow({ row: m }: { row: TranscriptRow }) {
  return (
    <div data-row="tool" className="loki-tool-row">
      · {m.text}
    </div>
  );
}

function EventRow({ row: m }: { row: TranscriptRow }) {
  return (
    <details data-row="event" className="loki-event-row">
      <summary className="loki-event-summary" style={{ cursor: m.detail ? "pointer" : "default", listStyle: m.detail ? "disclosure-closed" : "none" }}>
        ⟳ {m.text}
        {m.summary && <span className="loki-event-aside">{m.summary}</span>}
      </summary>
      {m.detail && <pre className="loki-event-detail">{m.detail}</pre>}
    </details>
  );
}

/** A user or assistant message: the bubble, and under a queued one the take-back button. */
function Bubble({ row: m, last, streaming, dim, onCancelQueued }: { row: TranscriptRow; last: boolean; streaming: boolean; dim: boolean; onCancelQueued?: (row: TranscriptRow) => void }) {
  return (
    <div data-row={m.role} data-queued={m.queued ? "true" : undefined} style={{ display: "flex", flexDirection: "column", alignItems: m.role === "user" ? "flex-end" : "flex-start", margin: "8px 0" }}>
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

function AssistantBody({ row: m, cursor }: { row: TranscriptRow; cursor: boolean }) {
  return (
    <div className="loki-md">
      <Markdown remarkPlugins={[remarkGfm]}>{m.text}</Markdown>
      {cursor && <span style={{ opacity: 0.6 }}>▍</span>}
    </div>
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
      {/* Your own words get the same markdown as the agent's: pasted prompts and skill text are full of it. */}
      {m.text && (
        <div className="loki-md">
          <Markdown remarkPlugins={[remarkGfm]}>{m.text}</Markdown>
        </div>
      )}
    </>
  );
}
