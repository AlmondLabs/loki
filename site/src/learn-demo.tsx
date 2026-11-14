import { useRef, useState, type KeyboardEvent } from "react";
import { dueCount, type RecallSnapshot } from "../../core/recall/model.ts";
import { ListIcon, ListRow } from "../../app/src/components";
import { learnSources } from "../../app/src/recall/learn-column";
import { Recall } from "../../app/src/recall/recall";
import { useLearnView } from "../../app/src/recall/use-learn-view";
import { PlaceSlotsProvider } from "../../app/src/shell/place-columns";
import { resolve, runAction } from "../../app/src/shell/keymap";
import type { Recall as RecallModel } from "../../app/src/shell/use-recall";
import { dismissLead, editCard, gradeCard, lessonOf, removeCard, restoreCard, restoreLead, startingLearn } from "./demo-learn";

/**
 * The Learn section's live demo: loki's own Learn, its views as the sidebar lists them, a view's list and the deck or
 * the item chosen beside it, over the made-up cards of demo-learn.ts. Show the answer, answer it, delete or edit it;
 * the leads view starts a lesson. Keys work while the window has focus, through the app's keymap, as in the Inbox demo.
 */
export function LearnDemo() {
  const recall = useDemoRecall();
  /** The lesson a lead began, said under the deck: on the site there is no chat to open it in. */
  const [lesson, setLesson] = useState<string | null>(null);
  /** Bumped by "start over", so the deck starts a fresh sitting. */
  const [visit, setVisit] = useState(0);
  // Learn draws its list and its detail into two slots, as the app's shell gives them (shell/place-columns.tsx).
  const [listSlot, setListSlot] = useState<HTMLElement | null>(null);
  const [detailSlot, setDetailSlot] = useState<HTMLElement | null>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const binding = resolve(e.nativeEvent, "learn");
    if (binding && runAction(binding.id)) e.preventDefault();
  };

  return (
    <div className="site-window" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="site-window-bar" aria-hidden>
        <span />
        <span />
        <span />
        <em>Learn · {recall.due} due</em>
      </div>
      <div className="site-learn">
        <div className="site-learn-column">
          <LearnViews recall={recall} />
        </div>
        <div ref={setListSlot} className="site-learn-list" />
        <div ref={setDetailSlot} className="site-learn-pane" />
        <PlaceSlotsProvider slots={{ list: listSlot, detail: detailSlot }}>
          <Recall
            key={visit}
            recall={recall}
            active
            onOpenDesk={() => setLesson("In the app, this opens the chat the card came from.")}
            onBegin={(_agent, _conversation, _brief, title) => setLesson(`In the app, “${title}” opens as a chat of its own and the agent begins the lesson.`)}
          />
        </PlaceSlotsProvider>
      </div>
      {lesson && (
        <div className="site-learn-note" role="status">
          {lesson}
        </div>
      )}
      <button
        type="button"
        className="site-start-over"
        onClick={() => {
          recall.reset();
          setLesson(null);
          setVisit((v) => v + 1);
        }}
      >
        start over
      </button>
    </div>
  );
}

/** Learn's views, as the app's sidebar lists them under Learn: Review with its due count, Leads, All Cards, Deleted. */
function LearnViews({ recall }: { recall: RecallModel }) {
  const [view, setView] = useLearnView();
  const sources = learnSources({ snap: recall.snap, due: recall.due, view, onView: setView });
  return (
    <ul className="loki-list">
      {sources.items.map((s) => (
        <ListRow
          key={s.id}
          lead={s.icon && <ListIcon name={s.icon} />}
          title={s.title}
          time={s.count ? String(s.count) : null}
          current={sources.selected === s.id}
          onOpen={() => sources.onSelect(s.id)}
        />
      ))}
    </ul>
  );
}

/** Learn's model, as the app's `useRecall` returns it, over the made-up snapshot; every move answers at once. */
function useDemoRecall(): RecallModel & { reset: () => void } {
  const [snap, setSnap] = useState<RecallSnapshot>(() => startingLearn(Date.now()));
  const lastDeleted = useRef<string | null>(null);
  const apply = (move: (s: RecallSnapshot, now: number) => RecallSnapshot) => {
    setSnap((s) => move(s, Date.now()));
    return Promise.resolve();
  };
  const done = () => Promise.resolve();
  return {
    snap,
    error: null,
    due: dueCount(snap.cards),
    running: false,
    starting: null,
    refresh: done,
    grade: (id, g) => apply(gradeCard(id, g)),
    remove: (id) => {
      lastDeleted.current = id;
      return apply(removeCard(id));
    },
    undo: () => {
      const id = lastDeleted.current;
      lastDeleted.current = null;
      return id ? apply(restoreCard(id)) : done();
    },
    restore: (id) => apply(restoreCard(id)),
    forget: (id) => apply((s) => ({ ...s, rejected: s.rejected.filter((r) => r.card.id !== id) })),
    edit: (id, text) => apply(editCard(id, text)),
    settings: (next) => apply((s) => ({ ...s, worker: { ...s.worker, ...next } })),
    run: done,
    exportCards: done,
    startLead: (id) => {
      const lead = snap.leads.find((l) => l.id === id);
      return Promise.resolve(lead ? lessonOf(lead) : null);
    },
    dismissLead: (id) => apply(dismissLead(id)),
    restoreLead: (id) => apply(restoreLead(id)),
    reset: () => {
      lastDeleted.current = null;
      setSnap(startingLearn(Date.now()));
    },
  };
}
