import { useEffect, useRef, useState } from "react";
import { ANSWERS, describeGap, previews, type Grade } from "../../../core/recall/fsrs.ts";
import { learnTitle, type CardWithSchedule, type RecallSnapshot } from "../../../core/recall/model.ts";
import { lessonBrief } from "../../../core/recall/extract.ts";
import { Button, Empty, Meta, PaneHeader } from "../components";
import { ContentList, NothingSelected, type ContentListHandle, type ContentRow } from "../shell/content-list";
import { PlaceColumns } from "../shell/place-columns";
import { ToolbarTitle } from "../item/toolbar";
import type { ItemProperty } from "../item/item-view";
import { useNow } from "../components/use-now";
import { registerActions } from "../shell/keymap";
import type { Recall as RecallModel } from "../shell/use-recall";
import {
  CardDetail,
  CardEditor,
  DismissedDetail,
  LeadDetail,
  LessonDetail,
  PreviousText,
  RecallIntro,
  RecallKeys,
  RejectedDetail,
  SourceLine,
} from "./recall-parts";
import { cardRows, deletedRows, dismissedRowId, holdDeckKeys, leadRowId, leadRows, lessonRowId, rejectedRowId, reviewRows, workerLine } from "./learn-list";
import { useDeckPass } from "./use-deck-pass";
import { useLearnView } from "./use-learn-view";
import { LEARN_VIEW_LABEL, stepLearnView, type LearnView as View } from "./views";

const TONE: Record<Grade, "negative" | "quiet" | "paper" | "positive"> = { 1: "negative", 2: "quiet", 3: "positive", 4: "paper" };

/** Each list view's chosen row; Review's is the card under your hands, held by the deck pass. */
type Picked = Record<Exclude<View, "review">, string | null>;

/**
 * Learn, the place's owner (plan 2026-11-14-1330, KTD1, KTD10): the view, its Search, the row chosen in each view and
 * the card being edited, drawn as the list column and the detail. The views are the sidebar's sources (learn-column.tsx)
 * and ⌘[ ⌘] step them. Review is the cards the worker wrote, one at a time: the front, then the answer on space, then
 * one of two answers — again, or got it — that schedules the next sight of it. Its list mirrors the due queue with the
 * card under your hands selected, and choosing a row reviews that card next. Deleting a card (X) puts it on the pile
 * the worker reads as "not this". Leads lists what is worth learning properly, each a lesson away; All Cards edits the
 * card chosen in the detail; Deleted holds the deleted cards and the dismissed leads, with Restore.
 */
export function Recall({
  recall,
  active,
  onOpenDesk,
  onBegin,
}: {
  recall: RecallModel;
  active: boolean;
  onOpenDesk: (agentId: string, conversationId: string) => void;
  onBegin: (agentId: string, conversationId: string, brief: string, title: string) => void;
}) {
  const { snap } = recall;
  const now = useNow();
  const [view, setView] = useLearnView();
  const cards = snap?.cards ?? [];
  const pass = useDeckPass(cards);
  const { current, revealed } = pass;
  /** Per-card UI state, by id, so it leaves with the card. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [previousId, setPreviousId] = useState<string | null>(null);
  const editing = !!current && editingId === current.card.id;
  /** All Cards' Search (it was the card list's own field). */
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Picked>({ leads: null, all: null, deleted: null });
  const pick = (v: keyof Picked, id: string | null) => setPicked((p) => ({ ...p, [v]: id }));

  const grade = (g: Grade) => {
    if (!current || !revealed) return;
    void recall.grade(current.card.id, g);
    pass.advance();
  };
  const remove = (id = current?.card.id) => {
    if (!id) return;
    void recall.remove(id);
    pass.advance(id);
  };
  const open = (id = current?.card.id) => {
    const s = cards.find((c) => c.card.id === id)?.card.source;
    if (s?.agent_id && s.conversation_id) onOpenDesk(s.agent_id, s.conversation_id);
  };
  /** Review's list, so X, E and O act on the row the person sees: it commits a pending highlight first (KTD3). */
  const listRef = useRef<ContentListHandle>(null);
  const onSeen = (run: (id: string) => void) => {
    if (listRef.current) listRef.current.act(run);
    else if (current) run(current.card.id);
  };
  // Space shows the answer, then stands for "got it"; the arrows show it first too, then answer — so a pass
  // through the deck is → → → with ← for the ones that slipped.
  const answer = (g: Grade) => (revealed ? grade(g) : pass.reveal());
  const keys = useRef({ reveal: () => {}, again: () => {}, good: () => {}, remove: () => {}, edit: () => {}, open: () => {} });
  useEffect(() => {
    keys.current = {
      reveal: () => answer(3),
      again: () => answer(1),
      good: () => answer(3),
      remove: () => onSeen(remove),
      edit: () => onSeen(setEditingId),
      open: () => onSeen(open),
    };
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
  // The place's own keys, whichever view shows: ⌘[ and ⌘] step the views (R16), ⌘R refreshes.
  useEffect(() => {
    if (!active) return;
    return registerActions({
      "learn.prevView": () => setView(stepLearnView(view, -1)),
      "learn.nextView": () => setView(stepLearnView(view, 1)),
      "recall.refresh": () => void recall.refresh(),
    });
  }, [active, recall, view, setView]);

  /** Return or Tab on a row: focus goes into the detail, where Review's keys answer the card. */
  const detailRef = useRef<HTMLDivElement>(null);

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
      onDelete={() => remove()}
      onEdit={() => setEditingId(current.card.id)}
      onOpen={() => open()}
      onTogglePrevious={() => setPreviousId((p) => (p === current.card.id ? null : current.card.id))}
      onSave={(text) => {
        void recall.edit(current.card.id, text);
        setEditingId(null);
      }}
      onCancel={() => setEditingId(null)}
    />
  );

  const shown = viewList(view, { snap, pass, query, picked, now });
  const listColumn = (
    // Review's list keeps the deck's answers to itself while it has focus (holdDeckKeys): → browses, never grades.
    <div className="loki-learn-list" onKeyDown={view === "review" ? (e) => holdDeckKeys(e.nativeEvent) : undefined}>
      <ContentList
        key={view}
        {...(view === "review" ? { ref: listRef } : {})}
        label={LEARN_VIEW_LABEL[view]}
        title={LEARN_VIEW_LABEL[view]}
        count={shown.rows.length || null}
        line={view === "all" && snap ? workerLine(snap.worker, now) : undefined}
        rows={shown.rows}
        selectedId={shown.selectedId}
        onSelect={(id) => (view === "review" ? pass.choose(id) : pick(view, id))}
        onEnter={() => detailRef.current?.focus()}
        empty={shown.empty}
        {...(view === "all" ? { query, onQuery: setQuery } : {})}
      />
    </div>
  );

  const item = (): React.ReactNode => {
    if (view === "review") {
      return (
        <ReviewView recall={recall} pass={pass}>
          {deck}
        </ReviewView>
      );
    }
    // With no snapshot the notices are all there is to show (an error, most likely); the wrapper leaves them to this.
    if (!snap) return <Notices recall={recall} />;
    const chosen = shown.selectedId;
    if (view === "leads") {
      const lead = snap.leads.find((l) => leadRowId(l.id) === chosen);
      const lesson = snap.lessons.find((s) => lessonRowId(s.conversation_id) === chosen);
      if (lead) {
        return (
          <LeadDetail
            lead={lead}
            starting={recall.starting}
            onStart={() =>
              void recall.startLead(lead.id).then((started) => {
                if (started) onBegin(started.agentId, started.conversationId, started.brief, started.title);
              })
            }
            onDismiss={() => {
              pick("leads", null);
              void recall.dismissLead(lead.id);
            }}
            onOpen={onOpenDesk}
          />
        );
      }
      if (lesson) {
        return (
          <LessonDetail
            lesson={lesson}
            onOpen={() => onOpenDesk(lesson.agent_id, lesson.conversation_id)}
            onResume={() => onBegin(lesson.agent_id, lesson.conversation_id, lessonBrief(lesson.lead), learnTitle(lesson.lead.title))}
          />
        );
      }
      return null;
    }
    if (view === "all") {
      const c = cards.find((x) => x.card.id === chosen);
      return c ? (
        <CardDetail
          c={c}
          now={now}
          onSave={(text) => void recall.edit(c.card.id, text)}
          onDelete={() => {
            pick("all", null);
            void recall.remove(c.card.id);
          }}
        />
      ) : null;
    }
    const r = snap.rejected.find((x) => rejectedRowId(x.card.id) === chosen);
    if (r) {
      return (
        <RejectedDetail
          r={r}
          onRestore={() => {
            pick("deleted", null);
            void recall.restore(r.card.id);
          }}
          onForget={() => {
            pick("deleted", null);
            void recall.forget(r.card.id);
          }}
        />
      );
    }
    const d = snap.dismissed_leads.find((x) => dismissedRowId(x.lead.id) === chosen);
    return d ? (
      <DismissedDetail
        d={d}
        onRestore={() => {
          pick("deleted", null);
          void recall.restoreLead(d.lead.id);
        }}
      />
    ) : null;
  };
  const body = item();

  const detail = (
    <div ref={detailRef} tabIndex={-1} className="loki-learn-detail" onPointerDown={(e) => e.stopPropagation()}>
      <RecallHeader recall={recall} />
      {body === null ? (
        <div style={{ position: "relative", flex: 1 }}>
          <NothingSelected noun={NOUN[view]} />
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            scrollbarGutter: "stable",
            padding: "20px 24px 16px",
            boxSizing: "border-box",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* The toolbar keeps its place across the views, at the pane's top as every pane's is. Inside the body, the
            deck sits in the middle of what is left (a little above it, where the eye rests); an item starts at the top.
            The gutter is reserved so a long item's scrollbar does not shift the column sideways. */}
          <div style={{ width: 760, maxWidth: "100%", margin: "0 auto", flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
            <div key={view} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16, animation: "loki-view-in 120ms ease-out" }}>
              {view !== "review" && snap && <Notices recall={recall} />}
              {body}
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return <PlaceColumns list={listColumn} detail={detail} />;
}

/** The item's name in each view's "No … Selected"; Review always shows the deck or what it says instead. */
const NOUN: Record<View, string> = { review: "Card", leads: "Lead", all: "Card", deleted: "Item" };

/**
 * A view's list: its rows, the one selected, and the sentence it says when empty (KTD3). Review's selection is the
 * card under your hands, falling back to the queue's first (KTD8); the other views select only what was chosen.
 */
function viewList(
  view: View,
  { snap, pass, query, picked, now }: { snap: RecallSnapshot | null; pass: ReturnType<typeof useDeckPass>; query: string; picked: Picked; now: number },
): { rows: ContentRow[]; selectedId: string | null; empty: string } {
  if (!snap) return { rows: [], selectedId: null, empty: "Loading…" };
  switch (view) {
    case "review":
      return {
        rows: reviewRows(pass.queue, now),
        selectedId: pass.current?.card.id ?? null,
        empty: snap.cards.length ? "Nothing is due." : snap.worker.enabled ? "No cards yet." : "Learn is off.",
      };
    case "leads":
      return {
        rows: leadRows(snap.leads, snap.lessons, now),
        selectedId: picked.leads,
        empty: snap.worker.enabled ? "No leads yet." : "Learn is off, so no leads are coming.",
      };
    case "all":
      return { rows: cardRows(snap.cards, query, now), selectedId: picked.all, empty: "No cards yet." };
    case "deleted":
      return { rows: deletedRows(snap.rejected, snap.dismissed_leads, now), selectedId: picked.deleted, empty: "Nothing deleted." };
  }
}

/** The title and the counts; the views are the sidebar's sources. */
function RecallHeader({ recall }: { recall: RecallModel }) {
  const { snap } = recall;
  const cards = snap?.cards.length ?? 0;
  const leads = snap?.leads.length ?? 0;
  const deleted = snap?.rejected.length ?? 0;
  // Learn's toolbar, the chat's anatomy (plan 2026-11-14-1300, 3): its name over a grey line of its counts.
  const facts: ItemProperty[] = [
    { key: "status", label: `${recall.due} due`, editable: false, ...(recall.due > 0 ? { tone: "attention" as const } : {}) },
    { key: "status", label: `${cards} ${cards === 1 ? "card" : "cards"}`, editable: false },
    ...(leads ? [{ key: "status" as const, label: `${leads} ${leads === 1 ? "lead" : "leads"}`, editable: false }] : []),
    ...(deleted ? [{ key: "status" as const, label: `${deleted} deleted`, editable: false }] : []),
  ];
  return <PaneHeader title="Learn" line={<ToolbarTitle title="Learn" facts={facts} titleAs="h1" />} />;
}

/** The notices above any view: an error, and the writer being off while cards exist. */
function Notices({ recall }: { recall: RecallModel }) {
  const { snap } = recall;
  return (
    <>
      {recall.error && (
        <Meta wrap style={{ color: "var(--loki-negative)" }}>
          {recall.error}
        </Meta>
      )}
      {snap && !snap.worker.enabled && snap.cards.length > 0 && (
        <Meta wrap>
          Learn is off: these are the cards so far, and no new ones are coming ·{" "}
          <Button bare size="sm" tone="brass" onClick={() => void recall.settings({ enabled: true })}>
            Turn On
          </Button>
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

/** What the review view shows around the card: loading, no cards at all, nothing due, or the deck with its key legend. */
function ReviewBody({ snap, pass, children }: { snap: RecallSnapshot | null; pass: ReturnType<typeof useDeckPass>; children: React.ReactNode }) {
  const now = useNow();
  if (!snap) return <Meta>Loading…</Meta>;
  if (snap.cards.length === 0) {
    const ran = snap.worker.last_run_at
      ? ` The worker last ran ${describeGap(now - new Date(snap.worker.last_run_at).getTime())} ago: ${snap.worker.last_run_note ?? ""}.`
      : " The worker has not run yet.";
    return (
      <Empty card title="Nothing to recall yet">
        Cards are written in the background from conversations that have gone quiet — nothing to do here but come back.{ran}
      </Empty>
    );
  }
  if (!pass.current) {
    return (
      <Empty card title={pass.passed.size ? "Done for now" : "Nothing due"}>
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
function Deck({
  c,
  position,
  total,
  revealed,
  editing,
  showPrevious,
  onReveal,
  onGrade,
  onDelete,
  onEdit,
  onOpen,
  onTogglePrevious,
  onSave,
  onCancel,
}: {
  c: CardWithSchedule;
  position: number;
  total: number;
  revealed: boolean;
  editing: boolean;
  showPrevious: boolean;
  onReveal: () => void;
  onGrade: (g: Grade) => void;
  onDelete: () => void;
  onEdit: () => void;
  onOpen: () => void;
  onTogglePrevious: () => void;
  onSave: (text: { front: string; back: string }) => void;
  onCancel: () => void;
}) {
  const gaps = previews(c.schedule);
  const canOpen = !!(c.card.source.agent_id && c.card.source.conversation_id);
  return (
    <section
      aria-label={`Card ${position} of ${total}`}
      style={{
        background: "var(--loki-panel)",
        border: "1px solid var(--loki-border)",
        borderRadius: "var(--loki-radius-lg)",
        boxShadow: "var(--loki-shadow-sheet)",
        padding: "18px 24px 16px",
        display: "grid",
        gap: 16,
        animation: "loki-card-next 200ms ease-out",
      }}
    >
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
          <div
            style={{
              fontSize: "var(--loki-text-display)",
              fontWeight: 600,
              lineHeight: 1.3,
              color: "var(--loki-fg)",
              whiteSpace: "pre-wrap",
              textWrap: "balance" as never,
              padding: "10px 0",
            }}
          >
            {c.card.front}
          </div>
          {revealed ? (
            <div
              style={{
                borderTop: "1px solid var(--loki-border)",
                paddingTop: 14,
                fontSize: "var(--loki-text-row)",
                lineHeight: 1.55,
                color: "var(--loki-fg)",
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}
            >
              {c.card.back}
            </div>
          ) : (
            <div style={{ display: "flex", justifyContent: "center", padding: "6px 0 2px" }}>
              <Button size="md" tone="paper" onClick={onReveal} kbd="space">
                Show Answer
              </Button>
            </div>
          )}
          {c.card.previous.length > 0 && (
            <div style={{ display: "grid", gap: 8 }}>
              <span>
                <Button size="sm" bare onClick={onTogglePrevious} aria-expanded={showPrevious}>
                  {showPrevious ? "Hide the Earlier Wording" : "What It Said Before"}
                </Button>
              </span>
              {showPrevious && <PreviousText c={c} />}
            </div>
          )}
        </>
      )}
      {revealed && !editing && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8, borderTop: "1px solid var(--loki-border)", paddingTop: 14 }}>
          {ANSWERS.map(({ grade, label, key }) => (
            <Button
              key={grade}
              size="md"
              tone={TONE[grade]}
              onClick={() => onGrade(grade)}
              kbd={key}
              title={`Next in ${gaps[grade]}`}
              style={{ justifyContent: "center" }}
            >
              {label} <span style={{ fontSize: "var(--loki-text-fine)", opacity: 0.75 }}>{gaps[grade]}</span>
            </Button>
          ))}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", borderTop: "1px solid var(--loki-border)", paddingTop: 12 }}>
        <Button size="sm" onClick={onDelete} kbd="X" title="Delete — it joins the pile the worker reads as 'not this'">
          Delete
        </Button>
        <Button size="sm" onClick={onEdit} kbd="E" disabled={editing}>
          Edit
        </Button>
        {canOpen && (
          <Button size="sm" onClick={onOpen} kbd="O">
            Open the Chat
          </Button>
        )}
      </div>
    </section>
  );
}
