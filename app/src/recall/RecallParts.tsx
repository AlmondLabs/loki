import { useState } from "react";
import { describeGap, isDue, isNew } from "../../../core/recall/fsrs.ts";
import { updatedSinceReview, type CardWithSchedule, type DismissedLead, type Lead, type Lesson, type Rejected, type WorkerStatus } from "../../../core/recall/model.ts";
import { Button, Chip, Empty, Field, Meta, Row, Switch, TextArea } from "../components";
import { ago } from "../desk/CatchUpParts";

/** The pieces around the deck: the source line, the card editor, the browse list, the deleted pile, the worker strip, the key legend. */

export function SourceLine({ c }: { c: CardWithSchedule }) {
  const { source } = c.card;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0, flexWrap: "wrap" }}>
      {source.agentName && <Chip static>{source.agentName}</Chip>}
      <Meta>{source.title ?? "a conversation"}{source.at ? ` · ${ago(source.at)}` : ""}</Meta>
      {isNew(c.schedule) && <Meta brass>new</Meta>}
      {updatedSinceReview(c) && <Meta brass>updated by recall · {ago(c.card.updatedAt)}</Meta>}
      {c.card.tags.map((t) => (
        <Chip key={t} tag>
          {t}
        </Chip>
      ))}
    </span>
  );
}

/** Where a card stands: "due", "in 3d", "new". */
export function dueWord(c: CardWithSchedule, now = Date.now()): string {
  if (isNew(c.schedule)) return "new";
  if (isDue(c.schedule, now)) return "due";
  return `in ${describeGap(new Date(c.schedule.due).getTime() - now)}`;
}

/** Front and back as text boxes; save or cancel. */
export function CardEditor({ c, onSave, onCancel }: { c: CardWithSchedule; onSave: (text: { front: string; back: string }) => void; onCancel: () => void }) {
  const [front, setFront] = useState(c.card.front);
  const [back, setBack] = useState(c.card.back);
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <TextArea value={front} onChange={(e) => setFront(e.target.value)} rows={2} aria-label="front" autoFocus />
      <TextArea value={back} onChange={(e) => setBack(e.target.value)} rows={4} aria-label="back" />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Button size="sm" onClick={onCancel}>cancel</Button>
        <Button size="sm" tone="brass" onClick={() => onSave({ front, back })} disabled={!front.trim() || !back.trim()}>save</Button>
      </div>
    </div>
  );
}

/** The earlier wording of a card, when the worker rewrote it. */
export function PreviousText({ c }: { c: CardWithSchedule }) {
  const prev = c.card.previous[c.card.previous.length - 1];
  if (!prev) return null;
  return (
    <div style={{ fontSize: 12, color: "var(--loki-muted)", lineHeight: 1.5, borderTop: "1px solid var(--loki-border)", paddingTop: 10 }}>
      <Meta>before · {ago(prev.at)} · by {prev.by === "you" ? "you" : "recall"}</Meta>
      <div style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>{prev.front}</div>
      <div style={{ marginTop: 2, whiteSpace: "pre-wrap", opacity: 0.85 }}>{prev.back}</div>
    </div>
  );
}

/** Every card, searchable, with its standing; a row opens for editing or deleting. */
export function CardList({ cards, onEdit, onDelete }: { cards: CardWithSchedule[]; onEdit: (id: string, text: { front: string; back: string }) => void; onDelete: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const needle = q.trim().toLowerCase();
  const shown = cards.filter((c) => !needle || c.card.front.toLowerCase().includes(needle) || c.card.back.toLowerCase().includes(needle) || c.card.tags.some((t) => t.includes(needle)));
  const sorted = [...shown].sort((a, b) => b.card.updatedAt.localeCompare(a.card.updatedAt));
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <Field value={q} onChange={(e) => setQ(e.target.value)} placeholder={`search ${cards.length} card${cards.length === 1 ? "" : "s"}…`} aria-label="search cards" />
      {sorted.length === 0 && <Empty title={needle ? "No card matches." : "No cards yet."}>{needle ? "Try fewer words." : "The worker writes them from your conversations as they go quiet."}</Empty>}
      <ul style={{ display: "grid", gap: 4, listStyle: "none", margin: 0, padding: 0 }}>
        {sorted.map((c) => (
          <li key={c.card.id} style={{ border: "1px solid var(--loki-border)", borderRadius: 8, padding: open === c.card.id ? 14 : 0 }}>
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
                  <Meta>{dueWord(c)} · {c.schedule.reps} review{c.schedule.reps === 1 ? "" : "s"} · {c.schedule.lapses} forgotten</Meta>
                  <span style={{ flex: 1 }} />
                  <Button size="sm" tone="negative" onClick={() => onDelete(c.card.id)}>delete</Button>
                </div>
                <PreviousText c={c} />
              </div>
            ) : (
              <Row flush onClick={() => setOpen(c.card.id)} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "baseline", padding: "10px 12px" }}>
                <span style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, color: "var(--loki-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.card.front}</div>
                  <div style={{ fontSize: 12, color: "var(--loki-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2 }}>{c.card.back}</div>
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
  if (!rejected.length) return <Empty title="Nothing deleted.">Deleting a card puts it here, where the worker reads it as an example of what not to write.</Empty>;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <Meta wrap>These teach the worker: a card deleted unseen says "not wanted", one deleted after many reviews says "badly written". They never come back reworded.</Meta>
      <ul style={{ display: "grid", gap: 4, listStyle: "none", margin: 0, padding: 0 }}>
      {rejected.map((r) => (
        <li key={r.card.id} style={{ border: "1px solid var(--loki-border)", borderRadius: 8, padding: "10px 12px", display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "center" }}>
          <span style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, color: "var(--loki-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.card.front}</div>
            <div style={{ fontSize: 12, color: "var(--loki-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2 }}>{r.card.back}</div>
            <Meta>deleted {ago(r.at)} · after {r.reps} review{r.reps === 1 ? "" : "s"}</Meta>
          </span>
          <span style={{ display: "flex", gap: 6 }}>
            <Button size="sm" onClick={() => onRestore(r.card.id)}>restore</Button>
            <Button size="sm" tone="quiet" onClick={() => onForget(r.card.id)} title="drop it from the pile too — the worker stops seeing it">forget</Button>
          </span>
        </li>
      ))}
      </ul>
    </div>
  );
}

/** The worker's knobs and its last word, plus the export. */
export function WorkerStrip({ worker, running, onSettings, onRun, onExport, cardCount }: { worker: WorkerStatus; running: boolean; onSettings: (s: { enabled?: boolean; model?: string | null; dailyCap?: number }) => void; onRun: () => void; onExport: () => void; cardCount: number }) {
  const [model, setModel] = useState(worker.model ?? "");
  const [cap, setCap] = useState(String(worker.dailyCap));
  return (
    <div style={{ display: "grid", gap: 10, borderTop: "1px solid var(--loki-border)", paddingTop: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span className="loki-label" style={{ fontSize: 9.5 }}>the worker</span>
        <Button size="sm" tone={worker.enabled ? "paper" : "quiet"} onClick={() => onSettings({ enabled: !worker.enabled })} aria-pressed={worker.enabled}>
          {worker.enabled ? "on" : "off"}
        </Button>
        <Meta wrap>
          {worker.lastRunAt ? `last run ${ago(worker.lastRunAt)} · ${worker.lastRunNote ?? ""}` : "has not run yet"} · {worker.writtenToday} of {worker.dailyCap} written today
        </Meta>
        <span style={{ flex: 1 }} />
        <Button size="sm" onClick={onRun} disabled={running || !worker.enabled} title="read the quiet conversations now instead of waiting for the timer">{running ? "running…" : "run now"}</Button>
        <Button size="sm" onClick={onExport} disabled={!cardCount} title="copies every card as Anki's plain-text import: front, back, tags">export for Anki</Button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span className="loki-label" style={{ fontSize: 9.5 }}>cards a day</span>
        <Field size="sm" mono value={cap} onChange={(e) => setCap(e.target.value)} onBlur={() => Number.isFinite(Number(cap)) && Number(cap) >= 0 && onSettings({ dailyCap: Number(cap) })} style={{ width: 64 }} aria-label="cards a day" />
        <span className="loki-label" style={{ fontSize: 9.5 }}>model</span>
        <Field size="sm" mono value={model} onChange={(e) => setModel(e.target.value)} onBlur={() => onSettings({ model: model.trim() || null })} placeholder="the agent's own" style={{ width: 260 }} aria-label="worker model" title="a model handle such as anthropic/claude-haiku-4-5; empty uses each agent's model" />
      </div>
    </div>
  );
}

/** The key legend under the deck. */
export function RecallKeys({ revealed }: { revealed: boolean }) {
  return (
    <div style={{ textAlign: "center", marginTop: 12, fontSize: 10.5, color: "var(--loki-muted)", letterSpacing: "0.06em", fontFamily: "var(--loki-mono)" }}>
      {revealed ? "← again · → got it (space too) · X delete · E edit · O open the desk · Z undo · esc back" : "space or → show the answer · X delete · E edit · O open the desk · Z undo · esc back"}
    </div>
  );
}

/**
 * The section before the writer has ever been on: what it does, what it costs, and the switch. Off by
 * default because it spends the user's model budget in the background; nothing is written until they say so.
 */
export function RecallIntro({ worker, onEnable }: { worker: WorkerStatus; onEnable?: () => void }) {
  return (
    <section aria-label="about learn" style={{ background: "var(--loki-panel)", border: "1px solid var(--loki-border)", borderRadius: 12, padding: "22px 24px", display: "grid", gap: 14, fontSize: 13.5, lineHeight: 1.55 }}>
      <div style={{ fontSize: 17, fontWeight: 500 }}>Flashcards from your conversations — when you want them.</div>
      <p style={{ margin: 0 }}>
        Recall is a writer that runs in the background. Every ten minutes it looks for conversations that have gone quiet, hands the new
        stretch of transcript to that agent in a hidden conversation of its own, and keeps whatever comes back as cards: one fact each, a
        question that stands alone, an answer in a line or two. You meet them here, on a schedule that spaces the ones you know and
        brings back the ones you miss. Deleting a card is the feedback — the writer reads the pile of deleted ones before writing again.
      </p>
      <p style={{ margin: 0 }}>
        In the same call it also names <b>leads</b>: concepts that went by in a conversation without being understood. Each waits under the
        leads tab until you start it — a <code style={{ fontFamily: "var(--loki-mono)" }}>[Learn]</code> conversation with the agent that was
        there, which teaches by asking, on a desk it furnishes with the outline — or say "not this", which it remembers.
      </p>
      <p style={{ margin: 0, color: "var(--loki-muted)" }}>
        It asks the agent's model, so every run spends a little of your provider budget — up to {worker.dailyCap} cards a day, and nothing at
        all while no conversation has new text. The hidden conversations sit in the desks tree as "recall" desks, so you can read what it was asked.
        Everything it writes is a file under <code style={{ fontFamily: "var(--loki-mono)" }}>~/.letta/loki/recall/</code>. It is off until you turn it on,
        and Settings › learn turns it off again.
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        {onEnable ? (
          <Button tone="brass" onClick={onEnable}>turn the writer on</Button>
        ) : (
          <Meta>turn it on from the Mac: Learn, or Settings › learn</Meta>
        )}
      </div>
    </section>
  );
}

/** Settings › learn: the writer's switch and knobs, in Settings' fact grid. */
export function RecallSettings({ worker, onSettings, onRun, running }: { worker: WorkerStatus; onSettings: (s: { enabled?: boolean; model?: string | null; dailyCap?: number }) => void; onRun: () => void; running: boolean }) {
  const [model, setModel] = useState(worker.model ?? "");
  const [cap, setCap] = useState(String(worker.dailyCap));
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Line label="writer">
        <span style={{ display: "inline-grid", gap: 4 }}>
          <Switch on={worker.enabled} onToggle={() => onSettings({ enabled: !worker.enabled })} label={worker.enabled ? "on — reads quiet conversations every ten minutes and writes cards" : "off — no conversation is read, nothing is written"} />
          <Meta wrap>each run asks the agent's model, so it spends a little of your provider budget; off by default for that reason</Meta>
        </span>
      </Line>
      <Line label="cards a day">
        <Field size="sm" mono value={cap} onChange={(e) => setCap(e.target.value)} onBlur={() => Number.isFinite(Number(cap)) && Number(cap) >= 0 && onSettings({ dailyCap: Number(cap) })} style={{ width: 64 }} aria-label="cards a day" />
      </Line>
      <Line label="model">
        <Field size="sm" mono value={model} onChange={(e) => setModel(e.target.value)} onBlur={() => onSettings({ model: model.trim() || null })} placeholder="the agent's own" style={{ width: 280 }} aria-label="the model the writer asks" />
      </Line>
      <Line label="last run">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <Meta wrap>{worker.lastRunAt ? `${ago(worker.lastRunAt)} · ${worker.lastRunNote ?? ""}` : "has not run yet"} · {worker.writtenToday} of {worker.dailyCap} written today</Meta>
          <Button size="sm" onClick={onRun} disabled={running || !worker.enabled} title="read the quiet conversations now instead of waiting for the timer">{running ? "running…" : "run now"}</Button>
        </span>
      </Line>
      <Line label="files"><Meta>~/.letta/loki/recall/ — cards, schedule and the deleted pile, one JSON file each</Meta></Line>
    </div>
  );
}

/** A labelled line in Settings' fact grid (the label column matches Settings' own). */
function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 12, alignItems: "start", fontSize: 13.5, lineHeight: 1.5 }}>
      <span className="loki-label" style={{ fontSize: 9.5, paddingTop: 4 }}>{label}</span>
      <span style={{ minWidth: 0 }}>{children}</span>
    </div>
  );
}

/** The word for a lead's depth. */
const DEPTH: Record<Lead["depth"], string> = { primer: "a primer · one sitting", course: "a course · several sittings" };

/**
 * The leads: things the writer thinks the person could learn properly, newest first, each with start (the
 * lesson opens as a [Learn] desk) and "not this" (the dismissed pile the writer reads). Under them, the
 * lessons under way, each a link to its desk.
 */
export function LeadList({ leads, lessons, worker, starting, onStart, onDismiss, onOpen }: { leads: Lead[]; lessons: Lesson[]; worker: WorkerStatus; starting: string | null; onStart: (id: string) => void; onDismiss: (id: string) => void; onOpen: (agentId: string, conversationId: string) => void }) {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      {leads.length === 0 && (
        <Empty card title="No leads yet.">
          {worker.enabled
            ? "When a conversation goes quiet, the writer names what went by in it without being understood — a concept, an acronym, something you took the agent's word for. They collect here, and each is a lesson away."
            : "Leads come from the writer, and the writer is off. Turn it on under review or in Settings › recall and they will collect here as conversations go quiet."}
        </Empty>
      )}
      {leads.map((l) => (
        <section key={l.id} aria-label={`lead: ${l.title}`} style={{ background: "var(--loki-panel)", border: "1px solid var(--loki-border)", borderRadius: 12, padding: "16px 20px 14px", display: "grid", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {l.source.agentName && <Chip static>{l.source.agentName}</Chip>}
            <Meta>{l.source.title ?? "a conversation"} · {ago(l.createdAt)}</Meta>
            <span style={{ flex: 1 }} />
            <Meta>{DEPTH[l.depth]}</Meta>
          </div>
          <div style={{ fontFamily: "var(--loki-display)", fontSize: 22, lineHeight: 1.3, color: "var(--loki-fg)", textWrap: "balance" as never }}>{l.title}</div>
          <div style={{ fontSize: 13.5, lineHeight: 1.5, color: "var(--loki-muted)", fontStyle: "italic", overflowWrap: "anywhere" }}>{l.why}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", borderTop: "1px solid var(--loki-border)", paddingTop: 12 }}>
            <Button size="sm" tone="brass" onClick={() => onStart(l.id)} disabled={starting !== null} title="a [Learn] conversation with this agent, on a desk it furnishes first">
              {starting === l.id ? "starting…" : "start the lesson"}
            </Button>
            <Button size="sm" onClick={() => onDismiss(l.id)} title="the writer remembers not to propose this again">not this</Button>
            {l.source.agentId && l.source.conversationId && (
              <Button size="sm" bare onClick={() => onOpen(l.source.agentId!, l.source.conversationId!)}>where it came up</Button>
            )}
          </div>
        </section>
      ))}
      {lessons.length > 0 && (
        <div style={{ display: "grid", gap: 6 }}>
          <Meta>lessons under way</Meta>
          {lessons.map((s) => (
            <Row key={s.conversationId} onClick={() => onOpen(s.agentId, s.conversationId)} title="open the lesson's desk">
              <span style={{ fontFamily: "var(--loki-display)", fontSize: 15, color: "var(--loki-fg)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{s.lead.title}</span>
              {s.lead.source.agentName && <Chip static>{s.lead.source.agentName}</Chip>}
              <Meta>started {ago(s.startedAt)}</Meta>
            </Row>
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
      <Meta>dismissed leads</Meta>
      {dismissed.map((d) => (
        <Row key={d.lead.id}>
          <span style={{ fontSize: 13.5, color: "var(--loki-fg)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{d.lead.title}</span>
          <Meta>{ago(d.at)}</Meta>
          <Button size="sm" bare onClick={() => onRestore(d.lead.id)}>restore</Button>
        </Row>
      ))}
    </div>
  );
}
