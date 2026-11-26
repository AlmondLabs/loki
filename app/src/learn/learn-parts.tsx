import { useState, type CSSProperties, type ReactNode } from "react";
import { GaugeIcon, MessagesSquareIcon, RepeatIcon, type LucideIcon } from "lucide-react";
import { isNew } from "../../../core/learn/fsrs.ts";
import {
  updatedSinceReview,
  type CardWithSchedule,
  type DismissedLead,
  type Lead,
  type Lesson,
  type Rejected,
  type WorkerStatus,
} from "../../../core/learn/model.ts";
import { Button, Chip, Field, Meta, Switch, TextArea } from "../components";
import { ago } from "../workspace/catch-up-parts";
import { Setting } from "../settings/layout";
import { Glyph } from "../shared/icons";
import { dueWord, writtenLine } from "./learn-list";
import type { LearnView } from "./views";
import { WELCOME_LINE, WELCOME_MORE, WELCOME_TITLE, welcomeRows, type WelcomeRow } from "./welcome";

export function SourceLine({ c }: { c: CardWithSchedule }) {
  const { source } = c.card;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
      {source.agent_name && <Chip static>{source.agent_name}</Chip>}
      <Meta>
        {source.title ?? "A conversation"}
        {source.at ? ` · ${ago(source.at)}` : ""}
      </Meta>
      {isNew(c.schedule) && <Meta brass>New</Meta>}
      {updatedSinceReview(c) && <Meta brass>Updated by Learn · {ago(c.card.updated_at)}</Meta>}
      {c.card.tags.map((t) => (
        <Chip key={t} tag>
          {t}
        </Chip>
      ))}
    </span>
  );
}

export function CardEditor({
  c,
  autoFocus = true,
  onSave,
  onCancel,
}: {
  c: CardWithSchedule;
  autoFocus?: boolean;
  onSave: (text: { front: string; back: string }) => void;
  onCancel: () => void;
}) {
  const [front, setFront] = useState(c.card.front);
  const [back, setBack] = useState(c.card.back);
  return (
    <div className="grid gap-3">
      <TextArea value={front} onChange={(e) => setFront(e.target.value)} rows={2} aria-label="Front" autoFocus={autoFocus} />
      <TextArea value={back} onChange={(e) => setBack(e.target.value)} rows={4} aria-label="Back" />
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" tone="positive" onClick={() => onSave({ front, back })} disabled={!front.trim() || !back.trim()}>
          Save
        </Button>
      </div>
    </div>
  );
}

export function PreviousText({ c }: { c: CardWithSchedule }) {
  const prev = c.card.previous.at(-1);
  if (!prev) return null;
  return (
    <div className="loki-meta loki-meta--wrap" style={{ lineHeight: 1.5, borderTop: "1px solid var(--loki-border)", paddingTop: 12 }}>
      <Meta>
        Before · {ago(prev.at)} · by {prev.by === "you" ? "you" : "recall"}
      </Meta>
      <div style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>{prev.front}</div>
      <div style={{ marginTop: 2, whiteSpace: "pre-wrap" }}>{prev.back}</div>
    </div>
  );
}

export function LearnColumn({ view, children }: { view: LearnView; children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col gap-4" style={{ width: 760, maxWidth: "100%", ...(view === "review" ? { margin: "0 auto" } : {}) }}>
      {children}
    </div>
  );
}

const DETAIL: CSSProperties = {
  background: "var(--loki-panel)",
  border: "1px solid var(--loki-border)",
  borderRadius: "var(--radius-xl)",
  boxShadow: "var(--loki-shadow-sheet)",
  padding: "16px 24px",
};
const DETAIL_LAYOUT = "grid gap-4";
const MOVES: CSSProperties = { borderTop: "1px solid var(--loki-border)", paddingTop: 12 };
const MOVES_LAYOUT = "flex flex-wrap items-center gap-2";
const TITLE: CSSProperties = {
  fontSize: "var(--text-2xl)",
  fontWeight: 600,
  lineHeight: 1.3,
  color: "var(--loki-fg)",
  whiteSpace: "pre-wrap",
  textWrap: "balance",
  overflowWrap: "anywhere",
};
const BODY: CSSProperties = { fontSize: "var(--text-sm)", lineHeight: 1.55, color: "var(--loki-fg)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" };

export function CardDetail({
  c,
  now,
  onSave,
  onDelete,
}: {
  c: CardWithSchedule;
  now?: number;
  onSave: (text: { front: string; back: string }) => void;
  onDelete: () => void;
}) {
  const [round, setRound] = useState(0);
  return (
    <section aria-label="Card" className={DETAIL_LAYOUT} style={DETAIL}>
      <SourceLine c={c} />
      <CardEditor key={`${c.card.id}:${round}`} c={c} autoFocus={false} onSave={onSave} onCancel={() => setRound((r) => r + 1)} />
      <div className={MOVES_LAYOUT} style={MOVES}>
        <Meta>
          {dueWord(c, now)} · {c.schedule.reps} review{c.schedule.reps === 1 ? "" : "s"} · {c.schedule.lapses} forgotten
        </Meta>
        <span className="flex-1" />
        <Button size="sm" tone="negative" onClick={onDelete} title="Delete — it joins the pile the worker reads as 'not this'">
          Delete
        </Button>
      </div>
      <PreviousText c={c} />
    </section>
  );
}

export function RejectedDetail({ r, onRestore, onForget }: { r: Rejected; onRestore: () => void; onForget: () => void }) {
  return (
    <section aria-label="Deleted card" className={DETAIL_LAYOUT} style={DETAIL}>
      <Meta>
        Deleted {ago(r.at)} · after {r.reps} review{r.reps === 1 ? "" : "s"}
      </Meta>
      <div style={TITLE}>{r.card.front}</div>
      <div style={BODY}>{r.card.back}</div>
      <Meta wrap>
        Deleted cards teach the worker: one deleted unseen says "not wanted", one deleted after many reviews says "badly written". They never come back
        reworded.
      </Meta>
      <div className={MOVES_LAYOUT} style={MOVES}>
        <Button size="sm" onClick={onRestore}>
          Restore
        </Button>
        <Button size="sm" tone="quiet" onClick={onForget} title="Drop it from the pile too — the worker stops seeing it">
          Forget
        </Button>
      </div>
    </section>
  );
}

export function LearnIntro({ worker, onEnable }: { worker: WorkerStatus; onEnable?: () => void }) {
  const [more, setMore] = useState(false);
  return (
    <section aria-labelledby="learn-welcome" className="grid justify-items-center gap-4" style={{ maxWidth: 440, margin: "0 auto" }}>
      <div className="grid gap-1" style={{ textAlign: "center" }}>
        <h2 id="learn-welcome" style={{ margin: 0, fontSize: "var(--text-2xl)", fontWeight: 700 }}>
          {WELCOME_TITLE}
        </h2>
        <p style={{ margin: 0, color: "var(--loki-muted)", fontSize: "var(--text-sm)" }}>{WELCOME_LINE}</p>
      </div>
      <ul className="grid gap-4" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {welcomeRows(worker.daily_cap).map((row) => {
          const Drawn = WELCOME_ICON[row.icon];
          return (
            <li key={row.icon} className="grid grid-cols-[28px_1fr] items-start gap-3">
              <span style={{ color: "var(--loki-accent)", paddingTop: 2 }}>
                <Glyph icon={Drawn} size={22} />
              </span>
              <span className="grid gap-0.5" style={{ fontSize: "var(--text-sm)", lineHeight: 1.4 }}>
                <b style={{ fontWeight: 600 }}>{row.head}</b>
                <span style={{ color: "var(--loki-muted)" }}>{row.line}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {more && (
        <div className="loki-meta loki-meta--wrap grid gap-2" style={{ lineHeight: 1.45 }}>
          {WELCOME_MORE.map((line) => (
            <p key={line} style={{ margin: 0 }}>
              {line}
            </p>
          ))}
        </div>
      )}
      <div className="grid justify-items-center gap-2">
        {onEnable ? (
          <Button tone="positive" size="md" onClick={onEnable}>
            Turn On Learn
          </Button>
        ) : (
          <Meta>Turn it on from the Mac: Learn, or Preferences › Learn.</Meta>
        )}
        <Button bare size="sm" tone="brass" aria-expanded={more} onClick={() => setMore((m) => !m)}>
          {more ? "Show Less" : "Learn More…"}
        </Button>
      </div>
    </section>
  );
}

const WELCOME_ICON: Record<WelcomeRow["icon"], LucideIcon> = { chats: MessagesSquareIcon, spaced: RepeatIcon, budget: GaugeIcon };

export function LearnSettings({
  worker,
  onSettings,
  onRun,
  running,
  onExport,
  cardCount,
}: {
  worker: WorkerStatus;
  onSettings: (s: { enabled?: boolean; daily_cap?: number }) => void;
  onRun: () => void;
  running: boolean;
  onExport: () => void;
  cardCount: number;
}) {
  const [cap, setCap] = useState(String(worker.daily_cap));
  return (
    <>
      <Setting
        label="Learn"
        help={`${
          worker.enabled
            ? "Reads conversations once they have been quiet for half an hour, several at a time, and writes the cards worth keeping."
            : "Off: no conversation is read, nothing is written."
        } Each run asks the agent's model, so it spends a little of your provider budget.`}
      >
        <Switch on={worker.enabled} onToggle={() => onSettings({ enabled: !worker.enabled })} label="Learn" hideLabel />
      </Setting>
      <Setting label="Cards a day" help="The most new cards Learn adds in a day.">
        <Field
          size="sm"
          mono
          value={cap}
          onChange={(e) => setCap(e.target.value)}
          onBlur={() => Number.isFinite(Number(cap)) && Number(cap) >= 0 && onSettings({ daily_cap: Number(cap) })}
          style={{ width: 64 }}
          aria-label="Cards a day"
        />
      </Setting>
      <Setting
        label="Last run"
        help={`${worker.last_run_at ? `${ago(worker.last_run_at)} · ${worker.last_run_note ?? ""}` : "Has not run yet"} · ${writtenLine(worker)}`}
      >
        <Button
          size="sm"
          onClick={onRun}
          disabled={running}
          title="Read every conversation with something new now, instead of waiting for it to be quiet for half an hour"
        >
          {running ? "Running…" : "Run Now"}
        </Button>
      </Setting>
      <Setting label="Export" help="Copies every card as Anki's plain-text import: front, back and tags.">
        <Button size="sm" onClick={onExport} disabled={!cardCount}>
          Export for Anki
        </Button>
      </Setting>
    </>
  );
}

const DEPTH: Record<Lead["depth"], string> = { primer: "A primer · one sitting", course: "A course · several sittings" };

function LeadSource({ lead, at }: { lead: Lead; at: string }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      {lead.source.agent_name && <Chip static>{lead.source.agent_name}</Chip>}
      <Meta>
        {lead.source.title ?? "A conversation"} · {ago(at)}
      </Meta>
      <span className="flex-1" />
      <Meta>{DEPTH[lead.depth]}</Meta>
    </span>
  );
}

export function LeadDetail({
  lead,
  starting,
  onStart,
  onDismiss,
  onOpen,
}: {
  lead: Lead;
  starting: string | null;
  onStart: () => void;
  onDismiss: () => void;
  onOpen: (agentId: string, conversationId: string) => void;
}) {
  const { agent_id: agentId, conversation_id: conversationId } = lead.source;
  return (
    <section aria-label={`Lead: ${lead.title}`} className={DETAIL_LAYOUT} style={DETAIL}>
      <LeadSource lead={lead} at={lead.created_at} />
      <div style={TITLE}>{lead.title}</div>
      <div style={{ ...BODY, color: "var(--loki-muted)", fontStyle: "italic" }}>{lead.why}</div>
      <div className={MOVES_LAYOUT} style={MOVES}>
        <Button
          size="sm"
          tone="positive"
          onClick={onStart}
          disabled={starting !== null}
          title="A [Learn] conversation with this agent: the chat opens, the brief goes out, the agent begins"
        >
          {starting === lead.id ? "Starting…" : "Start the Lesson"}
        </Button>
        <Button size="sm" onClick={onDismiss} title="Learn remembers not to propose this again">
          Not This
        </Button>
        {agentId && conversationId && (
          <Button size="sm" bare onClick={() => onOpen(agentId, conversationId)}>
            Where It Came Up
          </Button>
        )}
      </div>
    </section>
  );
}

export function LessonDetail({ lesson, onOpen, onResume }: { lesson: Lesson; onOpen: () => void; onResume: () => void }) {
  return (
    <section aria-label={`Lesson: ${lesson.lead.title}`} className={DETAIL_LAYOUT} style={DETAIL}>
      <LeadSource lead={lesson.lead} at={lesson.started_at} />
      <div style={TITLE}>{lesson.lead.title}</div>
      <Meta wrap>{lesson.empty ? "The brief never arrived: the lesson's chat is still empty." : `Started ${ago(lesson.started_at)}.`}</Meta>
      <div className={MOVES_LAYOUT} style={MOVES}>
        <Button size="sm" onClick={onOpen} title="Open the lesson's chat">
          Open the Lesson
        </Button>
        {lesson.empty && (
          <Button size="sm" tone="brass" onClick={onResume} title="Open the chat and send the brief as your first message">
            Send the Brief
          </Button>
        )}
      </div>
    </section>
  );
}

export function DismissedDetail({ d, onRestore }: { d: DismissedLead; onRestore: () => void }) {
  return (
    <section aria-label={`Dismissed lead: ${d.lead.title}`} className={DETAIL_LAYOUT} style={DETAIL}>
      <Meta>Dismissed {ago(d.at)}</Meta>
      <div style={TITLE}>{d.lead.title}</div>
      <div style={{ ...BODY, color: "var(--loki-muted)", fontStyle: "italic" }}>{d.lead.why}</div>
      <Meta wrap>Learn reads the dismissed leads before proposing again, so this one does not come back reworded.</Meta>
      <div className={MOVES_LAYOUT} style={MOVES}>
        <Button size="sm" onClick={onRestore}>
          Restore
        </Button>
      </div>
    </section>
  );
}
