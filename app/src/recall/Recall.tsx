import { useEffect, useRef, useState } from "react";
import { ANSWERS, describeGap, previews, type Grade } from "../../../core/recall/fsrs.ts";
import { learnTitle, type CardWithSchedule, type RecallSnapshot } from "../../../core/recall/model.ts";
import { lessonBrief } from "../../../core/recall/extract.ts";
import { Button, Chip, Empty, Meta, Title } from "../components";
import { useNow } from "../components/useNow";
import { registerActions } from "../shell/keymap";
import type { Recall as RecallModel } from "../shell/useRecall";
import { CardEditor, CardList, DismissedLeadList, LeadList, PreviousText, RecallIntro, RecallKeys, RejectedList, SourceLine, WorkerStrip } from "./RecallParts";
import { useDeckPass } from "./useDeckPass";

/**
 * Recall: the cards the worker wrote, one at a time. The front, then the answer on space, then one of two
 * answers — again, or got it — that schedules the next sight of it. No composer, no commands: the only ways
 * to shape what gets written are to delete a card (X — it joins the pile the worker reads as "not this")
 * or to edit it. New cards come first with a mark, so the first look at a card is also the chance to throw
 * it out. Beside the deck: the leads (things worth learning properly, each a lesson away), every card with
 * search, and the deleted pile with restore.
 */
type View = "review" | "leads" | "all" | "deleted";
const VIEWS: View[] = ["review", "leads", "all", "deleted"];
const TONE: Record<Grade, "negative" | "quiet" | "paper" | "positive"> = { 1: "negative", 2: "quiet", 3: "positive", 4: "paper" };

export function Recall({ recall, active, onOpenDesk, onBegin }: { recall: RecallModel; active: boolean; onOpenDesk: (agentId: string, conversationId: string) => void; onBegin: (agentId: string, conversationId: string, brief: string, title: string) => void }) {
  const { snap } = recall;
  const [view, setView] = useState<View>("review");
  const cards = snap?.cards ?? [];
  const pass = useDeckPass(cards);
  const { current, revealed } = pass;
  /** Per-card UI state, by id, so it leaves with the card. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [previousId, setPreviousId] = useState<string | null>(null);
  const editing = !!current && editingId === current.card.id;

  const grade = (g: Grade) => {
    if (!current || !revealed) return;
    void recall.grade(current.card.id, g);
    pass.advance();
  };
  const remove = () => {
    if (!current) return;
    void recall.remove(current.card.id);
    pass.advance();
  };
  const open = () => {
    const s = current?.card.source;
    if (s?.agentId && s.conversationId) onOpenDesk(s.agentId, s.conversationId);
  };
  // Space shows the answer, then stands for "got it"; the arrows show it first too, then answer — so a pass
  // through the deck is → → → with ← for the ones that slipped.
  const answer = (g: Grade) => (revealed ? grade(g) : pass.reveal());
  const keys = useRef({ reveal: () => {}, again: () => {}, good: () => {}, remove: () => {}, edit: () => {}, open: () => {} });
  useEffect(() => {
    keys.current = { reveal: () => answer(3), again: () => answer(1), good: () => answer(3), remove, edit: () => current && setEditingId(current.card.id), open };
  });
  // The deck's keys, registered once per showing; the handlers above are read at press time.
  useEffect(() => {
    if (!active || view !== "review") return;
    return registerActions({
      "recall.reveal": () => keys.current.reveal(),
      "recall.again": () => keys.current.again(),
      "recall.good": () => keys.current.good(),
      "recall.delete": () => keys.current.remove(),
      "recall.edit": () => keys.current.edit(),
      "recall.open": () => keys.current.open(),
      "recall.undo": () => void recall.undo(),
    });
  }, [active, view, recall]);
  // The section's own keys, whichever view shows: ⌘[ and ⌘] step the views, ⌘R refreshes.
  useEffect(() => {
    if (!active) return;
    const step = (d: 1 | -1) => setView((v) => VIEWS[(VIEWS.indexOf(v) + d + VIEWS.length) % VIEWS.length]);
    return registerActions({ "learn.prevView": () => step(-1), "learn.nextView": () => step(1), "recall.refresh": () => void recall.refresh() });
  }, [active, recall]);

  const deck = current && (
    <Deck
      c={current}
      position={pass.passed.size + 1}
      total={pass.total}
      revealed={revealed}
      editing={editing}
      showPrevious={previousId === current.card.id}
      onReveal={pass.reveal}
      onGrade={grade}
      onDelete={remove}
      onEdit={() => setEditingId(current.card.id)}
      onOpen={open}
      onTogglePrevious={() => setPreviousId((p) => (p === current.card.id ? null : current.card.id))}
      onSave={(text) => {
        void recall.edit(current.card.id, text);
        setEditingId(null);
      }}
      onCancel={() => setEditingId(null)}
    />
  );

  return (
    <div style={{ position: "absolute", inset: 0, overflowY: "auto", scrollbarGutter: "stable", padding: "20px 24px 16px", boxSizing: "border-box", display: "flex", flexDirection: "column" }}>
      {/* The header keeps its place across the views, so the tab just clicked stays under the pointer. Inside the
          body, the deck sits in the middle of what is left (a little above it, where the eye rests); the lists
          start at the top. The gutter is reserved so a long list's scrollbar does not shift the column sideways. */}
      <div style={{ width: 760, maxWidth: "100%", margin: "0 auto", flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
        <RecallHeader recall={recall} view={view} onView={setView} />
        <div key={view} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16, animation: "loki-view-in 120ms ease-out" }}>
          {view === "review" ? <ReviewView recall={recall} pass={pass}>{deck}</ReviewView> : <ListsView recall={recall} view={view} onOpenDesk={onOpenDesk} onBegin={onBegin} />}
        </div>
      </div>
    </div>
  );
}

/** The title, the counts, and the four view tabs. */
function RecallHeader({ recall, view, onView }: { recall: RecallModel; view: View; onView: (v: View) => void }) {
  const { snap } = recall;
  const cards = snap?.cards.length ?? 0;
  const leads = snap?.leads.length ?? 0;
  return (
    <header style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
      <Title page>learn</Title>
      <Meta>
        {recall.due} due · {cards} card{cards === 1 ? "" : "s"}
        {leads ? ` · ${leads} lead${leads === 1 ? "" : "s"}` : ""}
        {snap?.rejected.length ? ` · ${snap.rejected.length} deleted` : ""}
      </Meta>
      <span style={{ flex: 1 }} />
      <span role="tablist" aria-label="learn views" style={{ display: "inline-flex", gap: 4 }}>
        {VIEWS.map((v) => (
          <Chip key={v} role="tab" aria-selected={view === v} active={view === v} onClick={() => onView(v)}>
            {v === "all" ? "all cards" : v}
          </Chip>
        ))}
      </span>
    </header>
  );
}

/** The notices above any view: an error, and the writer being off while cards exist. */
function Notices({ recall }: { recall: RecallModel }) {
  const { snap } = recall;
  return (
    <>
      {recall.error && <Meta wrap style={{ color: "var(--loki-negative)" }}>{recall.error}</Meta>}
      {snap && !snap.worker.enabled && snap.cards.length > 0 && (
        <Meta wrap>
          the writer is off — these are the cards so far, no new ones are coming ·{" "}
          <Button bare size="sm" tone="brass" onClick={() => void recall.settings({ enabled: true })}>turn it on</Button>
        </Meta>
      )}
    </>
  );
}

/** The review view: the intro until the writer has ever been on, else the deck (passed in) with its states around it. */
function ReviewView({ recall, pass, children }: { recall: RecallModel; pass: ReturnType<typeof useDeckPass>; children: React.ReactNode }) {
  const { snap } = recall;
  const fresh = !!snap && !snap.worker.enabled && snap.cards.length === 0;
  return (
    <>
      <Notices recall={recall} />
      <div style={{ margin: "auto 0", paddingBottom: "8vh", display: "grid", gap: 16 }}>
        {fresh ? (
          <RecallIntro worker={snap.worker} onEnable={() => void recall.settings({ enabled: true })} />
        ) : (
          <ReviewBody snap={snap} pass={pass}>
            {children}
          </ReviewBody>
        )}
      </div>
    </>
  );
}

/** The three list views: leads, all cards with the worker strip, deleted (cards and leads). */
function ListsView({ recall, view, onOpenDesk, onBegin }: { recall: RecallModel; view: View; onOpenDesk: (agentId: string, conversationId: string) => void; onBegin: (agentId: string, conversationId: string, brief: string, title: string) => void }) {
  const { snap } = recall;
  if (!snap) return <Notices recall={recall} />;
  return (
    <>
      <Notices recall={recall} />
      {view === "leads" && (
        <LeadList
          leads={snap.leads}
          lessons={snap.lessons}
          worker={snap.worker}
          starting={recall.starting}
          onStart={async (id) => {
            const lesson = await recall.startLead(id);
            if (lesson) onBegin(lesson.agentId, lesson.conversationId, lesson.brief, lesson.title);
          }}
          onResume={(s) => onBegin(s.agentId, s.conversationId, lessonBrief(s.lead), learnTitle(s.lead.title))}
          onDismiss={(id) => void recall.dismissLead(id)}
          onOpen={onOpenDesk}
        />
      )}
      {view === "all" && (
        <>
          <CardList cards={snap.cards} onEdit={(id, text) => void recall.edit(id, text)} onDelete={(id) => void recall.remove(id)} />
          <WorkerStrip worker={snap.worker} running={recall.running} onSettings={(s) => void recall.settings(s)} onRun={() => void recall.run()} onExport={() => void recall.exportCards()} cardCount={snap.cards.length} />
        </>
      )}
      {view === "deleted" && (
        <>
          <RejectedList rejected={snap.rejected} onRestore={(id) => void recall.restore(id)} onForget={(id) => void recall.forget(id)} />
          <DismissedLeadList dismissed={snap.dismissedLeads} onRestore={(id) => void recall.restoreLead(id)} />
        </>
      )}
    </>
  );
}

/** What the review view shows around the card: loading, no cards at all, nothing due, or the deck with its key legend. */
function ReviewBody({ snap, pass, children }: { snap: RecallSnapshot | null; pass: ReturnType<typeof useDeckPass>; children: React.ReactNode }) {
  const now = useNow();
  if (!snap) return <Meta>loading…</Meta>;
  if (snap.cards.length === 0) {
    const ran = snap.worker.lastRunAt ? ` The worker last ran ${describeGap(now - new Date(snap.worker.lastRunAt).getTime())} ago: ${snap.worker.lastRunNote ?? ""}.` : " The worker has not run yet.";
    return <Empty card title="Nothing to recall yet.">Cards are written in the background from conversations that have gone quiet — nothing to do here but come back.{ran}</Empty>;
  }
  if (!pass.current) {
    return (
      <Empty card title={pass.passed.size ? "Done for now." : "Nothing due."}>
        {pass.passed.size ? `${pass.passed.size} card${pass.passed.size === 1 ? "" : "s"} this sitting. ` : ""}
        {pass.nextDue ? `The next one is due in ${describeGap(pass.nextDue - now)}.` : ""}
      </Empty>
    );
  }
  return (
    <>
      {children}
      <RecallKeys revealed={pass.revealed} />
    </>
  );
}

/** One card: its source, the front, the answer once shown, and the two answers. */
function Deck({ c, position, total, revealed, editing, showPrevious, onReveal, onGrade, onDelete, onEdit, onOpen, onTogglePrevious, onSave, onCancel }: { c: CardWithSchedule; position: number; total: number; revealed: boolean; editing: boolean; showPrevious: boolean; onReveal: () => void; onGrade: (g: Grade) => void; onDelete: () => void; onEdit: () => void; onOpen: () => void; onTogglePrevious: () => void; onSave: (text: { front: string; back: string }) => void; onCancel: () => void }) {
  const gaps = previews(c.schedule);
  const canOpen = !!(c.card.source.agentId && c.card.source.conversationId);
  return (
    <section aria-label={`card ${position} of ${total}`} style={{ background: "var(--loki-panel)", border: "1px solid var(--loki-border)", borderRadius: 12, boxShadow: "var(--loki-shadow-sheet)", padding: "18px 24px 16px", display: "grid", gap: 16, animation: "loki-card-next 200ms ease-out" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <SourceLine c={c} />
        <span style={{ flex: 1 }} />
        <Meta>
          {position} of {total}
        </Meta>
      </div>
      {editing ? (
        <CardEditor c={c} onSave={onSave} onCancel={onCancel} />
      ) : (
        <>
          <div style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.3, color: "var(--loki-fg)", whiteSpace: "pre-wrap", textWrap: "balance" as never, padding: "10px 0" }}>{c.card.front}</div>
          {revealed ? (
            <div style={{ borderTop: "1px solid var(--loki-border)", paddingTop: 14, fontSize: 15, lineHeight: 1.55, color: "var(--loki-fg)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{c.card.back}</div>
          ) : (
            <div style={{ display: "flex", justifyContent: "center", padding: "6px 0 2px" }}>
              <Button size="md" tone="paper" onClick={onReveal} kbd="space">show the answer</Button>
            </div>
          )}
          {c.card.previous.length > 0 && (
            <div style={{ display: "grid", gap: 8 }}>
              <span>
                <Button size="sm" bare onClick={onTogglePrevious} aria-expanded={showPrevious}>{showPrevious ? "hide the earlier wording" : "what it said before"}</Button>
              </span>
              {showPrevious && <PreviousText c={c} />}
            </div>
          )}
        </>
      )}
      {revealed && !editing && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8, borderTop: "1px solid var(--loki-border)", paddingTop: 14 }}>
          {ANSWERS.map(({ grade, label, key }) => (
            <Button key={grade} size="md" tone={TONE[grade]} onClick={() => onGrade(grade)} kbd={key} title={`next in ${gaps[grade]}`} style={{ justifyContent: "center" }}>
              {label} <span style={{ fontSize: 10.5, opacity: 0.75 }}>{gaps[grade]}</span>
            </Button>
          ))}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", borderTop: "1px solid var(--loki-border)", paddingTop: 12 }}>
        <Button size="sm" onClick={onDelete} kbd="X" title="delete — it joins the pile the worker reads as 'not this'">delete</Button>
        <Button size="sm" onClick={onEdit} kbd="E" disabled={editing}>edit</Button>
        {canOpen && <Button size="sm" onClick={onOpen} kbd="O">open the desk</Button>}
      </div>
    </section>
  );
}
