import { useState } from "react";
import { describeGap, isDue, isNew } from "../../../packages/core/src/recall/fsrs.ts";
import { updatedSinceReview, type CardWithSchedule, type Rejected, type WorkerStatus } from "../../../packages/core/src/recall/model.ts";
import { Button, Chip, Empty, Field, Meta, Row, TextArea } from "../ui";
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
      <div role="list" style={{ display: "grid", gap: 4 }}>
        {sorted.map((c) => (
          <div key={c.card.id} role="listitem" style={{ border: "1px solid var(--loki-border)", borderRadius: 8, padding: open === c.card.id ? 14 : 0 }}>
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
          </div>
        ))}
      </div>
    </div>
  );
}

/** Deleted cards: what the worker learns from. Restore one that was a mistake; forget one for good. */
export function RejectedList({ rejected, onRestore, onForget }: { rejected: Rejected[]; onRestore: (id: string) => void; onForget: (id: string) => void }) {
  if (!rejected.length) return <Empty title="Nothing deleted.">Deleting a card puts it here, where the worker reads it as an example of what not to write.</Empty>;
  return (
    <div role="list" style={{ display: "grid", gap: 4 }}>
      <Meta wrap>These teach the worker: a card deleted unseen says "not wanted", one deleted after many reviews says "badly written". They never come back reworded.</Meta>
      {rejected.map((r) => (
        <div key={r.card.id} role="listitem" style={{ border: "1px solid var(--loki-border)", borderRadius: 8, padding: "10px 12px", display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "center" }}>
          <span style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, color: "var(--loki-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.card.front}</div>
            <div style={{ fontSize: 12, color: "var(--loki-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2 }}>{r.card.back}</div>
            <Meta>deleted {ago(r.at)} · after {r.reps} review{r.reps === 1 ? "" : "s"}</Meta>
          </span>
          <span style={{ display: "flex", gap: 6 }}>
            <Button size="sm" onClick={() => onRestore(r.card.id)}>restore</Button>
            <Button size="sm" tone="quiet" onClick={() => onForget(r.card.id)} title="drop it from the pile too — the worker stops seeing it">forget</Button>
          </span>
        </div>
      ))}
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
