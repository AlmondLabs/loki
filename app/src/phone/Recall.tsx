import { useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useNow } from "../components/useNow";
import { ANSWERS, describeGap, isNew, previews, type Grade } from "../../../core/recall/fsrs.ts";
import { updatedSinceReview, type CardWithSchedule } from "../../../core/recall/model.ts";
import type { Recall as RecallModel } from "../shell/useRecall";
import type { useDeckPass } from "../recall/useDeckPass";
import { ago } from "../board/model";
import { avatarUrl } from "../desk/env";
import { Button } from "../components";
import { useLeave, type LeaveFrames } from "../kit/leave";
import { lastInput, prefersReducedMotion } from "../kit/motion";
import { spring } from "../kit/spring";
import { Avatar, SkeletonCard } from "./rows";
import { BackButton, Scroll, TopBar } from "./ui";

/** One sitting with the deck (recall/useDeckPass). Phone.tsx holds it above the routes, so leaving Learn and coming back keeps the card and the pass. */
export type DeckPass = ReturnType<typeof useDeckPass>;

/**
 * Learn on the phone: the same deck, thumb-sized, in the phone's grammar. The card names its source the
 * way a message names its author — the agent's face and name, the conversation, when — then the front,
 * one button for the answer, then Again or Got it side by side, each with its next gap; Delete and Undo
 * delete underneath. The pass is held by Phone.tsx, so opening Learn from Home or More resumes it; Back
 * returns to where it was opened from.
 *
 * The card moves as a card: Show the answer turns it over, a grade throws it off the way the Inbox throws
 * its cards (Got it to the right, Again to the left), a delete lets it fall away, and the next rises into
 * its place. Nothing moves for a key: a pass run from the keyboard is instant.
 */
export function Recall({ recall, pass, banner, backLabel = "home", onBack }: { recall: RecallModel; pass: DeckPass; banner: ReactNode; backLabel?: string; onBack: () => void }) {
  const cards = recall.snap?.cards ?? [];
  const { current } = pass;
  return (
    <div className="loki-phone-page">
      <TopBar left={<BackButton onClick={onBack} label={backLabel} />} title="Learn" sub={`${recall.due} due · ${cards.length} card${cards.length === 1 ? "" : "s"}${current && pass.total ? ` · ${pass.passed.size + 1} of ${pass.total}` : ""}`} progress={pass.total ? pass.passed.size / pass.total : null} />
      {banner}
      <Scroll>
        <div className="loki-phone-learn">
          {!recall.snap ? (
            <SkeletonCard label="Loading the cards…" />
          ) : !current && cards.length === 0 && !recall.snap.worker.enabled ? (
            <Off dailyCap={recall.snap.worker.dailyCap} />
          ) : !current ? (
            <Rest cards={cards.length} passed={pass.passed.size} nextDue={pass.nextDue} />
          ) : (
            <PhoneCard
              key={current.card.id}
              c={current}
              position={pass.passed.size + 1}
              total={pass.total}
              revealed={pass.revealed}
              onReveal={pass.reveal}
              onAnswer={(g) => {
                void recall.grade(current.card.id, g);
                pass.advance();
              }}
              onDelete={() => {
                void recall.remove(current.card.id);
                pass.advance();
              }}
              onUndo={() => void recall.undo()}
            />
          )}
        </div>
      </Scroll>
    </div>
  );
}

/** The writer is off and nothing is written: what Learn is, what it costs, and where it is switched on (the Mac). */
function Off({ dailyCap }: { dailyCap: number }) {
  return (
    <div className="loki-phone-empty">
      <p className="loki-phone-headline">Learn is off</p>
      <p>Once it is on, a writer on the Mac turns conversations that have gone quiet into flashcards, and they wait here on a schedule. Each run spends a little of your provider budget, up to {dailyCap} cards a day.</p>
      <p className="loki-phone-meta">Turn it on from the Mac: Learn, or Settings › learn.</p>
    </div>
  );
}

/** No card to show: none written yet, none due, or the sitting is done. */
function Rest({ cards, passed, nextDue }: { cards: number; passed: number; nextDue: number | undefined }) {
  const now = useNow();
  if (cards === 0)
    return (
      <div className="loki-phone-empty">
        <p className="loki-phone-headline">Nothing to learn yet</p>
        <p>Cards are written in the background from conversations that have gone quiet.</p>
      </div>
    );
  return (
    <div className="loki-phone-empty">
      <p className="loki-phone-headline">{passed ? "Done for now" : "Nothing due"}</p>
      {nextDue ? <p>The next one is due in {describeGap(nextDue - now)}.</p> : null}
    </div>
  );
}

/** Where the card came from, as a message header: the agent's face and name, the conversation and when, and what is new about it. */
function Source({ c }: { c: CardWithSchedule }) {
  const { source } = c.card;
  const fresh = isNew(c.schedule) ? "New" : updatedSinceReview(c) ? `Updated ${ago(c.card.updatedAt)}` : null;
  return (
    <div className="loki-phone-learn-source">
      <Avatar name={source.agentName ?? "agent"} src={source.agentId ? avatarUrl(source.agentId) : null} size={36} />
      <div className="loki-phone-row-copy">
        <span className="loki-phone-learn-who">
          <span className="loki-phone-ellipsis">{source.agentName ?? "A conversation"}</span>
          {fresh && <span className="loki-phone-learn-tag">{fresh}</span>}
        </span>
        <span className="loki-phone-row-preview">
          {source.title ?? "a conversation"}
          {source.at ? ` · ${ago(source.at)}` : ""}
          {c.card.tags.length ? ` · ${c.card.tags.join(", ")}` : ""}
        </span>
      </div>
    </div>
  );
}

/** How a graded card leaves: thrown right for a pass, left for a miss, the Inbox's directions and tilt. */
const THROW = (dir: 1 | -1): Keyframe[] => [{ transform: "none", opacity: 1 }, { transform: `translateX(${dir * 115}%) rotate(${dir * 8}deg)`, opacity: 0.6 }];
/** A deleted card sinks and fades where it was. */
const DROP: Keyframe[] = [{ transform: "none", opacity: 1 }, { transform: "translateY(24px) scale(0.94)", opacity: 0 }];
/** The half of a turn the card makes with its front up; the other half brings the answer round. */
const TURN_MS = 140;
const moves = () => lastInput() !== "key" && !prefersReducedMotion();

function PhoneCard({ c, position, total, revealed, onReveal, onAnswer, onDelete, onUndo }: { c: CardWithSchedule; position: number; total: number; revealed: boolean; onReveal: () => void; onAnswer: (g: Grade) => void; onDelete: () => void; onUndo: () => void }) {
  const gaps = previews(c.schedule);
  const ref = useRef<HTMLElement>(null);
  // How this card will leave, set by what sends it (a grade, a delete); read by useLeave as it unmounts.
  const exit = useRef<LeaveFrames>(null);
  useLeave(ref, () => exit.current, 280);
  // The card after one that left rises into its place; the first of a pass, or one reached by a key, is just there.
  const [rises] = useState(() => position > 1 && moves());
  const leave = (frames: LeaveFrames, then: () => void) => {
    exit.current = moves() ? frames : null;
    then();
  };
  // Turn the card over: the front turns away edge-on, the answer is put in, and the card comes round showing it.
  const reveal = () => {
    const el = ref.current;
    if (!el || typeof el.animate !== "function" || !moves()) return onReveal();
    const away = el.animate([{ transform: "perspective(1200px) rotateY(0deg)" }, { transform: "perspective(1200px) rotateY(90deg)" }], { duration: TURN_MS, easing: "ease-in", fill: "forwards" });
    const round = () => {
      flushSync(onReveal);
      away.cancel();
      const s = spring("snappy");
      el.animate([{ transform: "perspective(1200px) rotateY(-90deg)" }, { transform: "perspective(1200px) rotateY(0deg)" }], { duration: s.ms, easing: s.easing });
    };
    away.finished.then(round, round);
  };
  return (
    <section ref={ref} aria-label={`card ${position} of ${total}`} className="loki-phone-learn-card" data-rise={rises || undefined}>
      <Source c={c} />
      <div className="loki-phone-learn-front">{c.card.front}</div>
      {revealed ? (
        <div className="loki-phone-learn-back">{c.card.back}</div>
      ) : (
        <Button size="touch" tone="paper" block onClick={reveal}>
          Show the answer
        </Button>
      )}
      {revealed && (
        <div className="loki-phone-learn-grades">
          {ANSWERS.map(({ grade, label }) => (
            <button key={grade} type="button" className={grade >= 3 ? "loki-phone-decide-btn loki-phone-decide-btn--affirm" : "loki-phone-decide-btn"} aria-label={`${label}, next in ${gaps[grade]}`} onClick={() => leave(THROW(grade >= 3 ? 1 : -1), () => onAnswer(grade))}>
              <span className="loki-phone-learn-grade">{label[0].toUpperCase() + label.slice(1)}</span>
              <span className="loki-phone-learn-gap">{gaps[grade]}</span>
            </button>
          ))}
        </div>
      )}
      <div className="loki-phone-learn-foot">
        <Button size="touch" tone="negative" onClick={() => leave(DROP, onDelete)}>
          Delete card
        </Button>
        <Button size="touch" onClick={onUndo}>
          Undo delete
        </Button>
      </div>
    </section>
  );
}
