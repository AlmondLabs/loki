import { Fragment, createContext, memo, useContext, useEffect, useId, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MARKDOWN_COMPONENTS } from "./markdown-image";

import type { FileRef, TranscriptRow } from "../../../core/attention/transcript.ts";
import { commandFailed, commandRunning } from "../../../core/attention/thread.ts";
import { withoutReplies } from "../../../core/harness.ts";
import { chatImageUrl, inDesktop } from "../workspace/env";
import { revealItemInDir } from "../shell/desktop";
import { fileSize } from "./attachments";
import { Button, IconButton } from "../components";
import { AgentFace } from "../workspace/agent-chip";
import { Icon, Glyph, type IconName } from "../shared/icons";
import { clockLabel, dayPills } from "../shared/thread";
import { threadId } from "./transcript-window";
import { streamBlocks } from "./stream-blocks";
import { EventDetail, ToolSteps } from "./tool-steps";
import { isWorkRow, toolRuns } from "../shared/tool-steps";
import { BotIcon, CheckIcon, CopyIcon, LoaderCircleIcon } from "lucide-react";
import { Marker, MarkerContent, MarkerIcon } from "@/ui/marker";

export type { TranscriptRow };

export const Transcript = memo(function Transcript({
  rows,
  streaming = false,
  dim = true,
  onCancelQueued,
  people,
  dividerAt = null,
  dividerDay = null,
  widgets,
  onFrameWidget,
  onShowDesk,
  inline,
  from = 0,
  above = 0,
  arrivedFrom = Infinity,
  busy = false,
}: {
  rows: TranscriptRow[];
  streaming?: boolean;
  dim?: boolean;
  onCancelQueued?: (row: TranscriptRow) => void;
  from?: number;
  above?: number;
  arrivedFrom?: number;
  busy?: boolean;
} & MessageLayout) {
  const first = Math.max(0, Math.min(from, rows.length));
  const marks = new Map<number, WidgetMark[]>();
  for (const w of widgets ?? []) {
    if (w.before < first) continue;
    const list = marks.get(w.before);
    if (list) list.push(w);
    else marks.set(w.before, [w]);
  }
  const latest = new Map<string, string>();
  for (const w of widgets ?? []) if (w.earlier === undefined) latest.set(w.widgetId, w.id);
  const shown = first ? rows.slice(first) : rows;
  const timed = !!people && shown.some((r) => !!r.at && Number.isFinite(Date.parse(r.at)));
  const items = timed ? timeline(rows, marks, first) : null;
  const itemPills = items ? dayPills(items.map((it) => it.row ?? it.mark)) : null;
  let pills: Array<string | null> | null = null;
  if (items && itemPills) {
    const dayOf: Array<string | null> = rows.map(() => null);
    items.forEach((it, k) => {
      if (it.row) dayOf[it.i] = itemPills[k];
    });
    pills = dayOf;
  }
  const firsts = people ? runStarts(rows, dividerAt, pills, marks, first) : null;
  const tools = toolRuns(rows, first, (k) => marks.has(k) || !!pills?.[k] || k === dividerAt);
  const widgetRow = (w: WidgetMark) => (
    <Fragment key={`w-${w.id}`}>
      <WidgetRow mark={w} onFrame={onFrameWidget} onShowDesk={onShowDesk} />
      {inline && !w.gone && latest.get(w.widgetId) === w.id && inline(w.widgetId)}
    </Fragment>
  );
  const marksAt = (i: number) => marks.get(i)?.map(widgetRow);
  const message = (m: TranscriptRow, i: number) => {
    const last = i === rows.length - 1;
    if (isWorkRow(m)) {
      const end = tools.get(i);
      if (end === undefined) return null;
      const run = rows.slice(i, end);
      const tail = run[run.length - 1];
      const running = busy && end === rows.length && tail.role === "tool" && !tail.tool?.output && tail.tool?.row === undefined;
      return (
        <Fragment key={i - above}>
          {dividerAt === i && <Divider day={timed ? null : dividerDay} />}
          <ToolSteps rows={run} running={running} arrived={i >= arrivedFrom || undefined} />
        </Fragment>
      );
    }
    return (
      <Fragment key={i - above}>
        {dividerAt === i && <Divider day={timed ? null : dividerDay} />}
        <Row
          row={m}
          last={last}
          streaming={streaming && last}
          dim={dim}
          onCancelQueued={m.queued ? onCancelQueued : undefined}
          person={people && (m.role === "user" || m.role === "assistant") ? people[m.role] : undefined}
          first={firsts?.[i] ?? false}
          arrived={i >= arrivedFrom}
        />
      </Fragment>
    );
  };
  if (!items || !itemPills)
    return (
      <>
        {shown.map((m, k) => {
          const i = first + k;
          return (
            <Fragment key={i - above}>
              {marksAt(i)}
              {message(m, i)}
              {i === rows.length - 1 && marksAt(rows.length)}
            </Fragment>
          );
        })}
        {!rows.length && marksAt(0)}
      </>
    );
  const days: Array<{ label: string | null; start: number; end: number }> = [];
  itemPills.forEach((label, k) => {
    if (label || !days.length) days.push({ label, start: k, end: k + 1 });
    else days[days.length - 1].end = k + 1;
  });
  const draw = (d: { start: number; end: number }) => items.slice(d.start, d.end).map((it) => (it.row ? message(it.row, it.i) : widgetRow(it.mark)));
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

function timeline(rows: TranscriptRow[], marks: ReadonlyMap<number, WidgetMark[]>, from = 0): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (let i = from; i <= rows.length; i++) {
    for (const mark of marks.get(i) ?? []) out.push({ i, mark });
    if (i < rows.length) out.push({ i, row: rows[i] });
  }
  return out;
}

export function runStarts(
  rows: TranscriptRow[],
  dividerAt: number | null = null,
  pills: Array<string | null> | null = null,
  breaks: ReadonlyMap<number, unknown> | null = null,
  from = 0,
): boolean[] {
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

export interface Person {
  name: string;
  face?: string | null;
  avatar?: string | null;
}

export interface MessageLayout {
  people?: { user: Person; assistant: Person };
  dividerAt?: number | null;
  dividerDay?: string | null;
  widgets?: WidgetMark[];
  onFrameWidget?: (widgetId: string) => void;
  onShowDesk?: () => void;
  inline?: (widgetId: string) => ReactNode;
}

export interface WidgetMark {
  id: string;
  before: number;
  at: string;
  who: string;
  change: "added" | "changed" | "removed";
  title: string;
  widgetId: string;
  gone: boolean;
  earlier?: number;
}

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

function Divider({ day }: { day: string | null }) {
  return (
    <div className="loki-msg-divider" role="separator" aria-label={day ? `New since you last looked, ${day}` : "New since you last looked"}>
      {day && <span className="loki-msg-divider-day">{day}</span>}
      <span className="loki-msg-divider-rule" />
      <span className="loki-msg-divider-new">New</span>
    </div>
  );
}

export const MessageHold = createContext<((row: TranscriptRow) => void) | null>(null);

const HOLD_MS = 500;
const HOLD_SLOP = 8;

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
    // Outside (Android): a long press arrives as a context menu, as a right-click does; it opens the message's actions.
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      end();
      onHold(row);
    },
  };
}

const Row = memo(function Row({
  row: m,
  last,
  streaming,
  dim,
  onCancelQueued,
  person,
  first = false,
  arrived = false,
}: {
  row: TranscriptRow;
  last: boolean;
  streaming: boolean;
  dim: boolean;
  onCancelQueued?: (row: TranscriptRow) => void;
  person?: Person;
  first?: boolean;
  arrived?: boolean;
}) {
  const a = arrived || undefined;
  if (m.role === "event") return <EventRow row={m} arrived={a} />;
  if (person) return <Message row={m} last={last} streaming={streaming} person={person} first={first} onCancelQueued={onCancelQueued} arrived={a} />;
  return <Bubble row={m} last={last} streaming={streaming} dim={dim} onCancelQueued={onCancelQueued} arrived={a} />;
});

function Message({
  row: m,
  last,
  streaming,
  person,
  first,
  onCancelQueued,
  arrived,
}: {
  row: TranscriptRow;
  last: boolean;
  streaming: boolean;
  person: Person;
  first: boolean;
  onCancelQueued?: (row: TranscriptRow) => void;
  arrived?: true;
}) {
  const time = clockLabel(m.at);
  const hold = useMessageHold(m);
  const copyable = !!shownText(m) && !(last && streaming);
  return (
    <div
      data-row={m.role}
      data-queued={m.queued ? "true" : undefined}
      data-first={first ? "true" : undefined}
      data-arrived={arrived}
      className="loki-msg"
      {...hold}
    >
      <span className="loki-msg-face" aria-hidden>
        {first && <AgentFace name={person.face ?? person.name} src={person.avatar ?? null} size={36} />}
      </span>
      <div className="loki-msg-copy">
        {first && <div className="loki-msg-name">{person.name}</div>}
        {!first && <span className="sr-only">{person.name}: </span>}
        <div className="loki-msg-body">{m.role === "assistant" ? <AssistantBody row={m} cursor={last && streaming} /> : <UserBody row={m} />}</div>
        {m.queued && (
          <Button bare size="sm" tone="brass" onClick={() => onCancelQueued?.(m)} disabled={!onCancelQueued} className="loki-msg-queued">
            Queued · sends when this turn ends{onCancelQueued ? " · take back" : ""}
          </Button>
        )}
        {(copyable || time) && (
          <div className="loki-msg-actions">
            {copyable && <CopyMarkdown text={shownText(m)} className="loki-msg-action" />}
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

export const OpenChat = createContext<((agentId: string, conversationId: string) => void) | null>(null);

export const SUGGESTED = "suggested in another chat";

export function suggestedSource(m: TranscriptRow): { agent_id: string; conversation_id: string } | null {
  const link = m.link;
  return link?.agent_id && link.conversation_id ? link : null;
}

function SuggestedRow({ row: m, arrived }: { row: TranscriptRow; arrived?: true }) {
  const open = useContext(OpenChat);
  const from = suggestedSource(m);
  const words = (
    <>
      <span aria-hidden>↩ </span>
      {SUGGESTED}
      {m.summary && <span className="loki-event-aside">{m.summary}</span>}
    </>
  );
  return (
    <div data-row="event" data-arrived={arrived} className="loki-event-row">
      {open && from ? (
        <button type="button" className="loki-suggested-chip" onClick={() => open(from.agent_id, from.conversation_id)} title="Open the chat it came from">
          {words}
        </button>
      ) : (
        <span className="loki-suggested-chip">{words}</span>
      )}
    </div>
  );
}

export const OpenWorker = createContext<((subagentChat: string) => void) | null>(null);

export function SubagentEventRow({ row: m, arrived }: { row: TranscriptRow; arrived?: true }) {
  const open = useContext(OpenWorker);
  const subagentChat = m.subagent_chat;
  const go = open && subagentChat ? () => open(subagentChat) : undefined;
  return (
    <Marker data-row="event" data-arrived={arrived} render={go ? <button type="button" onClick={go} title="Open in Workers" /> : undefined}>
      <MarkerIcon>
        <BotIcon />
      </MarkerIcon>
      <MarkerContent className="truncate">
        {m.text}
        {m.summary && <span className="text-foreground"> · {m.summary}</span>}
      </MarkerContent>
    </Marker>
  );
}

const opens = (m: TranscriptRow): boolean => !!m.detail || m.row !== undefined;

export function DisclosureLine({ row: m, icon, arrived, more }: { row: TranscriptRow; icon: IconName; arrived?: true; more?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const words = (
    <>
      <MarkerIcon>
        <Icon name={icon} size={16} />
      </MarkerIcon>
      <MarkerContent className="truncate">
        {m.text}
        {m.summary && <span className="text-foreground"> · {m.summary}</span>}
      </MarkerContent>
    </>
  );
  if (!opens(m) && !more)
    return (
      <Marker data-row="event" data-arrived={arrived}>
        {words}
      </Marker>
    );
  return (
    <div data-row="event" data-arrived={arrived} className="flex flex-col gap-2">
      <Marker render={<button type="button" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(!open)} />}>{words}</Marker>
      {open && (
        <div id={panel} className="flex flex-col items-start gap-2 pl-6">
          {opens(m) && <EventDetail row={m} />}
          {more}
        </div>
      )}
    </div>
  );
}

export function ChatMessageLine({ row: m, arrived }: { row: TranscriptRow; arrived?: true }) {
  const open = useContext(OpenChat);
  const from = m.link;
  const go = open && from ? () => open(from.agent_id, from.conversation_id) : null;
  return (
    <DisclosureLine
      row={m}
      icon="desk"
      arrived={arrived}
      more={
        go && (
          <Button size="sm" onClick={go}>
            Open Chat
          </Button>
        )
      }
    />
  );
}

export function MovedLine({ row: m }: { row: TranscriptRow }) {
  const words = m.summary ? `${m.text} · ${m.summary}` : m.text;
  return (
    <Marker variant="separator" role="separator" aria-label={words} data-row="event" className="text-xs">
      <MarkerContent>{words}</MarkerContent>
    </Marker>
  );
}

export function CommandRow({ row: m, arrived }: { row: TranscriptRow; arrived?: true }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const running = commandRunning(m);
  const failed = commandFailed(m);
  return (
    <div data-row="command" data-arrived={arrived} className="ml-auto flex max-w-[85%] flex-col items-end gap-1">
      <code className="rounded-lg bg-accent px-3 py-2 text-sm text-foreground">{m.text}</code>
      <div className={`flex items-center gap-2 text-xs ${failed ? "text-loki-negative" : "text-muted-foreground"}`}>
        {running && <LoaderCircleIcon aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />}
        <span>{m.summary}</span>
        {opens(m) && (
          <Button bare size="sm" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(!open)}>
            {open ? "Hide Output" : "Show Output"}
          </Button>
        )}
      </div>
      {open && (
        <div id={panel} className="self-stretch">
          <EventDetail row={m} />
        </div>
      )}
    </div>
  );
}

export function kindedEvent(m: TranscriptRow, arrived?: true): ReactNode {
  switch (m.event) {
    case "subagent":
      return <SubagentEventRow row={m} arrived={arrived} />;
    case "command":
      return <CommandRow row={m} arrived={arrived} />;
    case "canvas":
      return <DisclosureLine row={m} icon="widget" arrived={arrived} />;
    case "chat_message":
      return <ChatMessageLine row={m} arrived={arrived} />;
    case "moved":
      return <MovedLine row={m} />;
    case undefined:
      return null;
  }
}

function EventRow({ row: m, arrived }: { row: TranscriptRow; arrived?: true }) {
  const kinded = kindedEvent(m, arrived);
  if (kinded) return kinded;
  if (m.subagent_chat) return <SubagentEventRow row={m} arrived={arrived} />;
  if (m.text === SUGGESTED) return <SuggestedRow row={m} arrived={arrived} />;
  return <DetailEventRow row={m} arrived={arrived} />;
}

function DetailEventRow({ row: m, arrived }: { row: TranscriptRow; arrived?: true }) {
  const [open, setOpen] = useState(false);
  const more = !!m.detail || m.row !== undefined;
  return (
    <details data-row="event" data-arrived={arrived} className="loki-event-row" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="loki-event-summary" style={{ cursor: more ? "pointer" : "default", listStyle: more ? "disclosure-closed" : "none" }}>
        ⟳ {m.text}
        {m.summary && <span className="loki-event-aside">{m.summary}</span>}
      </summary>
      {open && more && <EventDetail row={m} />}
    </details>
  );
}

function Bubble({
  row: m,
  last,
  streaming,
  dim,
  onCancelQueued,
  arrived,
}: {
  row: TranscriptRow;
  last: boolean;
  streaming: boolean;
  dim: boolean;
  onCancelQueued?: (row: TranscriptRow) => void;
  arrived?: true;
}) {
  return (
    <div
      data-row={m.role}
      data-queued={m.queued ? "true" : undefined}
      data-arrived={arrived}
      className="flex flex-col"
      style={{ alignItems: m.role === "user" ? "flex-end" : "flex-start", margin: "8px 0" }}
    >
      <div className="loki-bubble" data-role={m.role}>
        <div
          className="min-w-0"
          style={{
            maxWidth: "78%",
            overflowWrap: "anywhere",
            padding: "8px 12px",
            borderRadius: "var(--radius-xl)",
            background: m.role === "user" ? "var(--loki-user-bubble)" : "var(--loki-bubble)",
            border: m.queued ? "1px dashed var(--loki-accent)" : undefined,
            opacity: m.queued ? 0.7 : !dim || last || m.role === "user" ? 1 : 0.85,
            color: "var(--loki-fg)",
          }}
        >
          {m.role === "assistant" ? <AssistantBody row={m} cursor={last && streaming} /> : <UserBody row={m} />}
        </div>
        {shownText(m) && !(last && streaming) && <CopyMarkdown text={shownText(m)} />}
      </div>
      {m.queued && (
        <Button bare size="sm" tone="brass" onClick={() => onCancelQueued?.(m)} disabled={!onCancelQueued} style={{ marginTop: 4 }}>
          Queued · sends when this turn ends{onCancelQueued ? " · take back" : ""}
        </Button>
      )}
    </div>
  );
}

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
    } catch {}
  };
  return (
    <IconButton
      size={24}
      className={className}
      label={copied ? "Copied" : "Copy as Markdown"}
      data-copied={copied ? "true" : undefined}
      onClick={() => void copy()}
    >
      <Glyph icon={copied ? CheckIcon : CopyIcon} size={13} />
    </IconButton>
  );
}

export function useArrivedFrom(rows: TranscriptRow[] | undefined): number {
  const id = rows ? threadId(rows) : null;
  const [opened, setOpened] = useState<{ id: string | null; count: number }>({ id, count: rows?.length ?? Infinity });
  if (opened.id !== id) setOpened({ id, count: rows?.length ?? Infinity });
  return opened.id === id ? opened.count : Infinity;
}

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

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
      return words.map((w) =>
        /^\s+$/.test(w)
          ? { type: "text", value: w }
          : { type: "element", tagName: "span", properties: { className: ["loki-word"] }, children: [{ type: "text", value: w }] },
      );
    });
  };
  return (tree: HastNode) => wrap(tree, false);
}
const LIVE_PLUGINS = [rehypeWords];
const REMARK_PLUGINS = [remarkGfm];

const LiveBlock = memo(function LiveBlock({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={LIVE_PLUGINS} components={MARKDOWN_COMPONENTS}>
      {text}
    </Markdown>
  );
});

const StaticMarkdown = memo(function StaticMarkdown({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
      {text}
    </Markdown>
  );
});

export function shownText(m: TranscriptRow): string {
  return m.role === "assistant" ? withoutReplies(m.text) : m.text;
}

export function AssistantBody({ row: m, cursor }: { row: TranscriptRow; cursor: boolean }) {
  const text = withoutReplies(m.text);
  if (!cursor) {
    return (
      <div className="loki-md">
        <StaticMarkdown text={text} />
      </div>
    );
  }
  return (
    <div className="loki-md loki-md--live">
      {streamBlocks(text).map((block) => (
        <LiveBlock key={block.at} text={block.text} />
      ))}
      <span style={{ opacity: 0.6 }}>▍</span>
    </div>
  );
}

function FileChip({ file }: { file: FileRef }) {
  const body = (
    <>
      <Icon name="file" size={16} />
      <span className="loki-file-chip-name">{file.name}</span>
      {file.size !== undefined && <span className="loki-file-chip-size">{fileSize(file.size)}</span>}
    </>
  );
  if (!inDesktop)
    return (
      <span className="loki-file-chip" title={file.path}>
        {body}
      </span>
    );
  return (
    <button
      type="button"
      className="loki-file-chip"
      title={`Show ${file.path} in its folder`}
      onClick={() => void revealItemInDir(file.path).catch((err: unknown) => console.warn("loki: reveal file", err))}
    >
      {body}
    </button>
  );
}

function UserBody({ row: m }: { row: TranscriptRow }) {
  return (
    <>
      {m.images && m.images.length > 0 && (
        <div className="flex flex-wrap gap-2" style={{ marginBottom: m.text ? 8 : 0 }}>
          {m.images.map((src, k) => (
            <img
              key={k}
              src={chatImageUrl(src)}
              alt=""
              className="block"
              style={{ maxWidth: 220, maxHeight: 160, borderRadius: "var(--radius-md)", border: "1px solid var(--loki-border)" }}
            />
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
      {m.text && (
        <div className="loki-md">
          <StaticMarkdown text={m.text} />
        </div>
      )}
    </>
  );
}
