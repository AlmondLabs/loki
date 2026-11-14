import { useState } from "react";
import { GaugeIcon, MessagesSquareIcon, RepeatIcon, type LucideIcon } from "lucide-react";
import { describeGap, isDue, isNew } from "../../../core/recall/fsrs.ts";
import {
  updatedSinceReview,
  type CardWithSchedule,
  type DismissedLead,
  type Lead,
  type Lesson,
  type Rejected,
  type WorkerStatus,
} from "../../../core/recall/model.ts";
import { Button, Chip, Empty, Field, Meta, Row, Switch, TextArea } from "../components";
import { ago } from "../desk/catch-up-parts";
import { Setting } from "../settings/layout";
import { Glyph } from "../shared/icons";
import { WELCOME_LINE, WELCOME_MORE, WELCOME_TITLE, welcomeRows, type WelcomeRow } from "./welcome";

/** The pieces around the deck: the source line, the card editor, the browse list, the deleted pile, the worker strip, the key legend. */

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

/** Where a card stands: "Due", "In 3d", "New". */
export function dueWord(c: CardWithSchedule, now = Date.now()): string {
  if (isNew(c.schedule)) return "New";
  if (isDue(c.schedule, now)) return "Due";
  return `In ${describeGap(new Date(c.schedule.due).getTime() - now)}`;
}

/** Front and back as text boxes; save or cancel. */
export function CardEditor({ c, onSave, onCancel }: { c: CardWithSchedule; onSave: (text: { front: string; back: string }) => void; onCancel: () => void }) {
  const [front, setFront] = useState(c.card.front);
  const [back, setBack] = useState(c.card.back);
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <TextArea value={front} onChange={(e) => setFront(e.target.value)} rows={2} aria-label="Front" autoFocus />
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

/** Every card, searchable, with its standing; a row opens for editing or deleting. */
export function CardList({
  cards,
  onEdit,
  onDelete,
}: {
  cards: CardWithSchedule[];
  onEdit: (id: string, text: { front: string; back: string }) => void;
  onDelete: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const needle = q.trim().toLowerCase();
  const shown = cards.filter(
    (c) => !needle || c.card.front.toLowerCase().includes(needle) || c.card.back.toLowerCase().includes(needle) || c.card.tags.some((t) => t.includes(needle)),
  );
  const sorted = [...shown].sort((a, b) => b.card.updated_at.localeCompare(a.card.updated_at));
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <Field
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`Search ${cards.length} card${cards.length === 1 ? "" : "s"}…`}
        aria-label="Search cards"
      />
      {sorted.length === 0 && (
        <Empty title={needle ? "No card matches" : "No cards yet"}>
          {needle ? "Try fewer words." : "The worker writes them from your conversations as they go quiet."}
        </Empty>
      )}
      <ul style={{ display: "grid", gap: 4, listStyle: "none", margin: 0, padding: 0 }}>
        {sorted.map((c) => (
          <li key={c.card.id} style={{ border: "1px solid var(--loki-border)", borderRadius: "var(--loki-radius-md)", padding: open === c.card.id ? 14 : 0 }}>
            {open === c.card.id ? (
              <div style={{ display: "grid", gap: 10 }}>
                <SourceLine c={c} />
                <CardEditor
                  c={c}
                  onSave={(text) => {
                    onEdit(c.card.id, text);
                    setOpen(null);
                  }}
                  onCancel={() => setOpen(null)}
                />
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Meta>
                    {dueWord(c)} · {c.schedule.reps} review{c.schedule.reps === 1 ? "" : "s"} · {c.schedule.lapses} forgotten
                  </Meta>
                  <span style={{ flex: 1 }} />
                  <Button size="sm" tone="negative" onClick={() => onDelete(c.card.id)}>
                    Delete
                  </Button>
                </div>
                <PreviousText c={c} />
              </div>
            ) : (
              <Row
                flush
                onClick={() => setOpen(c.card.id)}
                style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "baseline", padding: "10px 12px" }}
              >
                <span style={{ minWidth: 0 }}>
                  <div
                    style={{ fontSize: "var(--loki-text-body)", color: "var(--loki-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {c.card.front}
                  </div>
                  <div className="loki-meta" style={{ marginTop: 2 }}>
                    {c.card.back}
                  </div>
                </span>
                <Meta brass={isDue(c.schedule)}>{dueWord(c)}</Meta>
              </Row>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Deleted cards: what the worker learns from. Restore one that was a mistake; forget one for good. */
export function RejectedList({ rejected, onRestore, onForget }: { rejected: Rejected[]; onRestore: (id: string) => void; onForget: (id: string) => void }) {
  if (!rejected.length)
    return <Empty title="Nothing deleted">Deleting a card puts it here, where the worker reads it as an example of what not to write.</Empty>;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <Meta wrap>
        These teach the worker: a card deleted unseen says "not wanted", one deleted after many reviews says "badly written". They never come back reworded.
      </Meta>
      <ul style={{ display: "grid", gap: 4, listStyle: "none", margin: 0, padding: 0 }}>
        {rejected.map((r) => (
          <li
            key={r.card.id}
            style={{
              border: "1px solid var(--loki-border)",
              borderRadius: "var(--loki-radius-md)",
              padding: "10px 12px",
              display: "grid",
              gridTemplateColumns: "1fr auto",
              gap: 12,
              alignItems: "center",
            }}
          >
            <span style={{ minWidth: 0 }}>
              <div style={{ fontSize: "var(--loki-text-body)", color: "var(--loki-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.card.front}
              </div>
              <div className="loki-meta" style={{ marginTop: 2 }}>
                {r.card.back}
              </div>
              <Meta>
                Deleted {ago(r.at)} · after {r.reps} review{r.reps === 1 ? "" : "s"}
              </Meta>
            </span>
            <span style={{ display: "flex", gap: 6 }}>
              <Button size="sm" onClick={() => onRestore(r.card.id)}>
                Restore
              </Button>
              <Button size="sm" tone="quiet" onClick={() => onForget(r.card.id)} title="Drop it from the pile too — the worker stops seeing it">
                Forget
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "3 of 5 written today", or, at the cap, that cards resume after midnight. */
function writtenLine(worker: WorkerStatus): string {
  if (worker.daily_cap > 0 && worker.written_today >= worker.daily_cap) return `today's ${worker.daily_cap} cards are written — more after midnight`;
  return `${worker.written_today} of ${worker.daily_cap} written today`;
}

/** The worker's knobs and its last word, plus the export. */
export function WorkerStrip({
  worker,
  running,
  onSettings,
  onRun,
  onExport,
  cardCount,
}: {
  worker: WorkerStatus;
  running: boolean;
  onSettings: (s: { enabled?: boolean; daily_cap?: number }) => void;
  onRun: () => void;
  onExport: () => void;
  cardCount: number;
}) {
  const [cap, setCap] = useState(String(worker.daily_cap));
  return (
    <div style={{ display: "grid", gap: 10, borderTop: "1px solid var(--loki-border)", paddingTop: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span className="loki-label">The worker</span>
        <Button size="sm" tone={worker.enabled ? "paper" : "quiet"} onClick={() => onSettings({ enabled: !worker.enabled })} aria-pressed={worker.enabled}>
          {worker.enabled ? "On" : "Off"}
        </Button>
        <Meta wrap>
          {worker.last_run_at ? `Last run ${ago(worker.last_run_at)} · ${worker.last_run_note ?? ""}` : "Has not run yet"} · {writtenLine(worker)}
        </Meta>
        <span style={{ flex: 1 }} />
        <Button
          size="sm"
          onClick={onRun}
          disabled={running}
          title="Read every conversation with something new now, instead of waiting for it to be quiet for half an hour"
        >
          {running ? "Running…" : "Run Now"}
        </Button>
        <Button size="sm" onClick={onExport} disabled={!cardCount} title="Copies every card as Anki's plain-text import: front, back, tags">
          Export for Anki
        </Button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span className="loki-label">Cards a day</span>
        <Field
          size="sm"
          mono
          value={cap}
          onChange={(e) => setCap(e.target.value)}
          onBlur={() => Number.isFinite(Number(cap)) && Number(cap) >= 0 && onSettings({ daily_cap: Number(cap) })}
          style={{ width: 64 }}
          aria-label="Cards a day"
        />
      </div>
    </div>
  );
}

/** The key legend under the deck. */
export function RecallKeys({ revealed }: { revealed: boolean }) {
  return (
    <div className="loki-meta loki-meta--wrap" style={{ textAlign: "center", marginTop: 12, fontFamily: "var(--loki-mono)" }}>
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

/** Preferences › Learn: the writer's switch and knobs, in Settings' fact grid. */
export function RecallSettings({
  worker,
  onSettings,
  onRun,
  running,
}: {
  worker: WorkerStatus;
  onSettings: (s: { enabled?: boolean; daily_cap?: number }) => void;
  onRun: () => void;
  running: boolean;
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
    </>
  );
}

/** The word for a lead's depth. */
const DEPTH: Record<Lead["depth"], string> = { primer: "A primer · one sitting", course: "A course · several sittings" };

/**
 * The leads: things the writer thinks the person could learn properly, newest first, each with start (the
 * lesson opens as a [Learn] desk) and "not this" (the dismissed pile the writer reads). Under them, the
 * lessons under way, each a link to its desk.
 */
export function LeadList({
  leads,
  lessons,
  worker,
  starting,
  onStart,
  onResume,
  onDismiss,
  onOpen,
}: {
  leads: Lead[];
  lessons: Lesson[];
  worker: WorkerStatus;
  starting: string | null;
  onStart: (id: string) => void;
  onResume: (lesson: Lesson) => void;
  onDismiss: (id: string) => void;
  onOpen: (agentId: string, conversationId: string) => void;
}) {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      {leads.length === 0 && (
        <Empty card title="No leads yet">
          {worker.enabled
            ? "When a chat goes quiet, Learn names what went by in it without being understood — a concept, an acronym, something you took the agent's word for. They collect here, and each is a lesson away."
            : "Leads come from Learn, and it is off. Turn it on in Review or in Preferences › Learn and they will collect here as chats go quiet."}
        </Empty>
      )}
      {leads.map((l) => (
        <section
          key={l.id}
          aria-label={`Lead: ${l.title}`}
          style={{
            background: "var(--loki-panel)",
            border: "1px solid var(--loki-border)",
            borderRadius: "var(--loki-radius-lg)",
            overflow: "hidden",
            display: "grid",
          }}
        >
          {/* The card is the start: one click opens the lesson's chat with the chat and sends the brief. */}
          <Row
            flush
            onClick={() => onStart(l.id)}
            disabled={starting !== null}
            title="A [Learn] conversation with this agent: the chat opens, the brief goes out, the agent begins"
            style={{ display: "grid", gap: 10, padding: "16px 20px 14px", textAlign: "left", alignItems: "stretch" }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {l.source.agent_name && <Chip static>{l.source.agent_name}</Chip>}
              <Meta>
                {l.source.title ?? "A conversation"} · {ago(l.created_at)}
              </Meta>
              <span style={{ flex: 1 }} />
              <Meta>{DEPTH[l.depth]}</Meta>
            </span>
            <span
              style={{
                display: "block",
                fontSize: "var(--loki-text-display)",
                fontWeight: 700,
                lineHeight: 1.3,
                color: "var(--loki-fg)",
                textWrap: "balance" as never,
              }}
            >
              {l.title}
            </span>
            <span
              style={{
                display: "block",
                fontSize: "var(--loki-text-body)",
                lineHeight: 1.5,
                color: "var(--loki-muted)",
                fontStyle: "italic",
                overflowWrap: "anywhere",
              }}
            >
              {l.why}
            </span>
            <span
              style={{
                display: "block",
                fontSize: "var(--loki-text-meta)",
                color: starting === l.id ? "var(--loki-muted)" : "var(--loki-accent)",
                fontWeight: 600,
              }}
            >
              {starting === l.id ? "Furnishing the canvas…" : "Start the lesson →"}
            </span>
          </Row>
          <div
            style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", borderTop: "1px solid var(--loki-border)", padding: "10px 20px 12px" }}
          >
            <Button size="sm" onClick={() => onDismiss(l.id)} title="Learn remembers not to propose this again">
              Not This
            </Button>
            {l.source.agent_id && l.source.conversation_id && (
              <Button
                size="sm"
                bare
                onClick={() => {
                  const { agent_id: agentId, conversation_id: conversationId } = l.source;
                  if (agentId && conversationId) onOpen(agentId, conversationId);
                }}
              >
                Where It Came Up
              </Button>
            )}
          </div>
        </section>
      ))}
      {lessons.length > 0 && (
        <div style={{ display: "grid", gap: 6 }}>
          <Meta>Lessons under way</Meta>
          {lessons.map((s) => (
            <div key={s.conversation_id} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", alignItems: "center", gap: 10 }}>
              <Row flush onClick={() => onOpen(s.agent_id, s.conversation_id)} title="Open the lesson's chat" style={{ minWidth: 0 }}>
                <span
                  style={{
                    fontSize: "var(--loki-text-row)",
                    fontWeight: 700,
                    color: "var(--loki-fg)",
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flex: 1,
                  }}
                >
                  {s.lead.title}
                </span>
                {s.lead.source.agent_name && <Chip static>{s.lead.source.agent_name}</Chip>}
                <Meta>{s.empty ? "The brief never arrived" : `Started ${ago(s.started_at)}`}</Meta>
              </Row>
              {s.empty && (
                <Button size="sm" tone="brass" onClick={() => onResume(s)} title="Open the chat and send the brief as your first message">
                  Send the Brief
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Leads the person said "not this" to, with a way back. */
export function DismissedLeadList({ dismissed, onRestore }: { dismissed: DismissedLead[]; onRestore: (id: string) => void }) {
  if (dismissed.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <Meta>Dismissed leads</Meta>
      {dismissed.map((d) => (
        <Row key={d.lead.id}>
          <span
            style={{
              fontSize: "var(--loki-text-body)",
              color: "var(--loki-fg)",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
            }}
          >
            {d.lead.title}
          </span>
          <Meta>{ago(d.at)}</Meta>
          <Button size="sm" bare onClick={() => onRestore(d.lead.id)}>
            Restore
          </Button>
        </Row>
      ))}
    </div>
  );
}
