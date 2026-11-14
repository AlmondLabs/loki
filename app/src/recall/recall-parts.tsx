import { useState, type CSSProperties } from "react";
import { GaugeIcon, MessagesSquareIcon, RepeatIcon, type LucideIcon } from "lucide-react";
import { isNew } from "../../../core/recall/fsrs.ts";
import {
  updatedSinceReview,
  type CardWithSchedule,
  type DismissedLead,
  type Lead,
  type Lesson,
  type Rejected,
  type WorkerStatus,
} from "../../../core/recall/model.ts";
import { Button, Chip, Field, Meta, Switch, TextArea } from "../components";
import { ago } from "../desk/catch-up-parts";
import { Setting } from "../settings/layout";
import { Glyph } from "../shared/icons";
import { dueWord, writtenLine } from "./learn-list";
import { WELCOME_LINE, WELCOME_MORE, WELCOME_TITLE, welcomeRows, type WelcomeRow } from "./welcome";

/** The pieces around the deck: the source line, the card editor, the details of what Learn's lists hold, the key legend. */

/** Where a card came from: the agent's name as a chip, then the chat's title and how long ago. */
export function SourceLine({ c }: { c: CardWithSchedule }) {
  const { source } = c.card;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0, flexWrap: "wrap" }}>
      {source.agent_name && <Chip static>{source.agent_name}</Chip>}
      <Meta>
        {source.title ?? "A conversation"}
        {source.at ? ` · ${ago(source.at)}` : ""}
      </Meta>
      {isNew(c.schedule) && <Meta brass>New</Meta>}
      {updatedSinceReview(c) && <Meta brass>Updated by recall · {ago(c.card.updated_at)}</Meta>}
      {c.card.tags.map((t) => (
        <Chip key={t} tag>
          {t}
        </Chip>
      ))}
    </span>
  );
}

/** Front and back as text boxes; save or cancel. The deck's editor takes the caret; All Cards' detail leaves it (`autoFocus`). */
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
    <div style={{ display: "grid", gap: 10 }}>
      <TextArea value={front} onChange={(e) => setFront(e.target.value)} rows={2} aria-label="Front" autoFocus={autoFocus} />
      <TextArea value={back} onChange={(e) => setBack(e.target.value)} rows={4} aria-label="Back" />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
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

/** The earlier wording of a card, when the worker rewrote it. */
export function PreviousText({ c }: { c: CardWithSchedule }) {
  const prev = c.card.previous.at(-1);
  if (!prev) return null;
  return (
    <div className="loki-meta loki-meta--wrap" style={{ lineHeight: 1.5, borderTop: "1px solid var(--loki-border)", paddingTop: 10 }}>
      <Meta>
        Before · {ago(prev.at)} · by {prev.by === "you" ? "you" : "recall"}
      </Meta>
      <div style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>{prev.front}</div>
      <div style={{ marginTop: 2, whiteSpace: "pre-wrap", opacity: 0.85 }}>{prev.back}</div>
    </div>
  );
}

/** A detail's card: the deck's look, for the one item chosen in Leads, All Cards or Deleted. */
const DETAIL: CSSProperties = {
  background: "var(--loki-panel)",
  border: "1px solid var(--loki-border)",
  borderRadius: "var(--loki-radius-lg)",
  boxShadow: "var(--loki-shadow-sheet)",
  padding: "18px 24px 16px",
  display: "grid",
  gap: 14,
};
/** The row of a detail's buttons under a hairline. */
const MOVES: CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", borderTop: "1px solid var(--loki-border)", paddingTop: 12 };
/** A detail's title: the card's front, the lead's name. */
const TITLE: CSSProperties = {
  fontSize: "var(--loki-text-display)",
  fontWeight: 600,
  lineHeight: 1.3,
  color: "var(--loki-fg)",
  whiteSpace: "pre-wrap",
  textWrap: "balance",
  overflowWrap: "anywhere",
};
/** A detail's body text: the card's back, the line quoting where a lead came up. */
const BODY: CSSProperties = { fontSize: "var(--loki-text-row)", lineHeight: 1.55, color: "var(--loki-fg)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" };

/**
 * A card chosen in All Cards, edited in the detail (R14): where it came from, its front and back in boxes, how it
 * stands, and Delete. Cancel puts the saved wording back. Choosing it never moves focus into the boxes (KTD7).
 */
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
  // Bumped by Cancel: the editor starts over from the card as saved.
  const [round, setRound] = useState(0);
  return (
    <section aria-label="Card" style={DETAIL}>
      <SourceLine c={c} />
      <CardEditor key={`${c.card.id}:${round}`} c={c} autoFocus={false} onSave={onSave} onCancel={() => setRound((r) => r + 1)} />
      <div style={MOVES}>
        <Meta>
          {dueWord(c, now)} · {c.schedule.reps} review{c.schedule.reps === 1 ? "" : "s"} · {c.schedule.lapses} forgotten
        </Meta>
        <span style={{ flex: 1 }} />
        <Button size="sm" tone="negative" onClick={onDelete} title="Delete — it joins the pile the worker reads as 'not this'">
          Delete
        </Button>
      </div>
      <PreviousText c={c} />
    </section>
  );
}

/** A deleted card chosen in Deleted: what it said, when it went, and Restore or Forget. */
export function RejectedDetail({ r, onRestore, onForget }: { r: Rejected; onRestore: () => void; onForget: () => void }) {
  return (
    <section aria-label="Deleted card" style={DETAIL}>
      <Meta>
        Deleted {ago(r.at)} · after {r.reps} review{r.reps === 1 ? "" : "s"}
      </Meta>
      <div style={TITLE}>{r.card.front}</div>
      <div style={BODY}>{r.card.back}</div>
      <Meta wrap>
        Deleted cards teach the worker: one deleted unseen says "not wanted", one deleted after many reviews says "badly written". They never come back
        reworded.
      </Meta>
      <div style={MOVES}>
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

/** The key legend under the deck. */
export function RecallKeys({ revealed }: { revealed: boolean }) {
  return (
    <div className="loki-meta loki-meta--wrap loki-mono" style={{ textAlign: "center", marginTop: 12 }}>
      {revealed
        ? "← again · → got it (space too) · X delete · E edit · O open the chat · Z undo · esc back"
        : "space or → show the answer · X delete · E edit · O open the chat · Z undo · esc back"}
    </div>
  );
}

/**
 * Learn's welcome before it has ever been on (plan 2026-11-14-0852, 2), as Apple's welcome sheets are: a title, three
 * rows of a symbol, a bold line and a sentence, one filled button, and the rest behind Learn More…. Off by default
 * because it spends the person's model budget in the background; nothing is written until they say so.
 */
export function RecallIntro({ worker, onEnable }: { worker: WorkerStatus; onEnable?: () => void }) {
  const [more, setMore] = useState(false);
  return (
    <section aria-labelledby="learn-welcome" style={{ display: "grid", gap: 20, justifyItems: "center", maxWidth: 440, margin: "0 auto" }}>
      <div style={{ display: "grid", gap: 4, textAlign: "center" }}>
        <h2 id="learn-welcome" style={{ margin: 0, fontSize: "var(--loki-text-hero)", fontWeight: 700 }}>
          {WELCOME_TITLE}
        </h2>
        <p style={{ margin: 0, color: "var(--loki-muted)", fontSize: "var(--loki-text-body)" }}>{WELCOME_LINE}</p>
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 16 }}>
        {welcomeRows(worker.daily_cap).map((row) => {
          const Drawn = WELCOME_ICON[row.icon];
          return (
            <li key={row.icon} style={{ display: "grid", gridTemplateColumns: "28px 1fr", gap: 12, alignItems: "start" }}>
              <span style={{ color: "var(--loki-accent)", paddingTop: 2 }}>
                <Glyph icon={Drawn} size={22} />
              </span>
              <span style={{ display: "grid", gap: 2, fontSize: "var(--loki-text-body)", lineHeight: 1.4 }}>
                <b style={{ fontWeight: 600 }}>{row.head}</b>
                <span style={{ color: "var(--loki-muted)" }}>{row.line}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {more && (
        <div style={{ display: "grid", gap: 8, fontSize: "var(--loki-text-meta)", color: "var(--loki-muted)", lineHeight: 1.45 }}>
          {WELCOME_MORE.map((line) => (
            <p key={line} style={{ margin: 0 }}>
              {line}
            </p>
          ))}
        </div>
      )}
      <div style={{ display: "grid", gap: 6, justifyItems: "center" }}>
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

/** The welcome's symbols, from the one icon set (Lucide): chats, the spaced repeat, the budget's gauge. */
const WELCOME_ICON: Record<WelcomeRow["icon"], LucideIcon> = { chats: MessagesSquareIcon, spaced: RepeatIcon, budget: GaugeIcon };

/**
 * Preferences › Learn: the writer's switch and knobs, in Settings' fact grid, and the export for Anki. They were the
 * strip under All Cards until Learn moved onto the list (plan 2026-11-14-1330, KTD10), which keeps only the grey line.
 */
export function RecallSettings({
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

/** The word for a lead's depth. */
const DEPTH: Record<Lead["depth"], string> = { primer: "A primer · one sitting", course: "A course · several sittings" };

/** Where a lead came up: the agent's name as a chip, the chat's title and how long ago. */
function LeadSource({ lead, at }: { lead: Lead; at: string }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      {lead.source.agent_name && <Chip static>{lead.source.agent_name}</Chip>}
      <Meta>
        {lead.source.title ?? "A conversation"} · {ago(at)}
      </Meta>
      <span style={{ flex: 1 }} />
      <Meta>{DEPTH[lead.depth]}</Meta>
    </span>
  );
}

/**
 * A lead chosen in Leads: something the writer thinks the person could learn properly, with Start the Lesson (the
 * lesson opens as a [Learn] chat and its brief goes out), Not This (the dismissed pile the writer reads) and the chat
 * where it came up.
 */
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
    <section aria-label={`Lead: ${lead.title}`} style={DETAIL}>
      <LeadSource lead={lead} at={lead.created_at} />
      <div style={TITLE}>{lead.title}</div>
      <div style={{ ...BODY, color: "var(--loki-muted)", fontStyle: "italic" }}>{lead.why}</div>
      <div style={MOVES}>
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

/** A lesson under way chosen in Leads: the lead it began from, a way to its chat, and Send the Brief when it never arrived. */
export function LessonDetail({ lesson, onOpen, onResume }: { lesson: Lesson; onOpen: () => void; onResume: () => void }) {
  return (
    <section aria-label={`Lesson: ${lesson.lead.title}`} style={DETAIL}>
      <LeadSource lead={lesson.lead} at={lesson.started_at} />
      <div style={TITLE}>{lesson.lead.title}</div>
      <Meta wrap>{lesson.empty ? "The brief never arrived: the lesson's chat is still empty." : `Started ${ago(lesson.started_at)}.`}</Meta>
      <div style={MOVES}>
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

/** A dismissed lead chosen in Deleted: what it was, when it was dismissed, and Restore. */
export function DismissedDetail({ d, onRestore }: { d: DismissedLead; onRestore: () => void }) {
  return (
    <section aria-label={`Dismissed lead: ${d.lead.title}`} style={DETAIL}>
      <Meta>Dismissed {ago(d.at)}</Meta>
      <div style={TITLE}>{d.lead.title}</div>
      <div style={{ ...BODY, color: "var(--loki-muted)", fontStyle: "italic" }}>{d.lead.why}</div>
      <Meta wrap>Learn reads the dismissed leads before proposing again, so this one does not come back reworded.</Meta>
      <div style={MOVES}>
        <Button size="sm" onClick={onRestore}>
          Restore
        </Button>
      </div>
    </section>
  );
}
