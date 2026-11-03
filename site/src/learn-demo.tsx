import { useRef, useState, type KeyboardEvent } from "react";
import { dueCount, type RecallSnapshot } from "../../core/recall/model.ts";
import { LearnColumn } from "../../app/src/recall/learn-column";
import { Recall } from "../../app/src/recall/recall";
import { resolve, runAction } from "../../app/src/shell/keymap";
import type { Recall as RecallModel } from "../../app/src/shell/use-recall";
import { dismissLead, editCard, gradeCard, lessonOf, removeCard, restoreCard, restoreLead, startingLearn } from "./demo-learn";

/**
 * The Learn section's live demo: loki's own Learn column and review deck over the made-up cards of demo-learn.ts.
 * Show the answer, answer it, delete or edit it; the leads view starts a lesson. Keys work while the window has
 * focus, through the app's keymap, as in the Inbox demo.
 */
export function LearnDemo() {
  const recall = useDemoRecall();
  /** The lesson a lead began, said under the deck: on the site there is no chat to open it in. */
  const [lesson, setLesson] = useState<string | null>(null);
  /** Bumped by "start over", so the deck starts a fresh sitting. */
  const [visit, setVisit] = useState(0);

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
          <LearnColumn recall={recall} />
        </div>
        <div className="site-learn-pane">
          <Recall
            key={visit}
            recall={recall}
            active
            onOpenDesk={() => setLesson("In the app, this opens the chat the card came from.")}
            onBegin={(_agent, _conversation, _brief, title) => setLesson(`In the app, “${title}” opens as a chat of its own and the agent begins the lesson.`)}
          />
        </div>
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
