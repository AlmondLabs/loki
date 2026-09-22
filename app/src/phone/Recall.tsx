import type { ReactNode } from "react";
import { useNow } from "../components/useNow";
import { ANSWERS, describeGap, isNew, previews, type Grade } from "../../../core/recall/fsrs.ts";
import { updatedSinceReview, type CardWithSchedule } from "../../../core/recall/model.ts";
import type { Recall as RecallModel } from "../shell/useRecall";
import { RecallIntro } from "../recall/RecallParts";
import type { useDeckPass } from "../recall/useDeckPass";
import { ago } from "../board/model";
import { avatarUrl } from "../desk/env";
import { Button } from "../components";
import { Avatar } from "./rows";
import { BackButton, Scroll, TopBar } from "./ui";

/** One sitting with the deck (recall/useDeckPass). Phone.tsx holds it above the routes, so leaving Learn and coming back keeps the card and the pass. */
export type DeckPass = ReturnType<typeof useDeckPass>;

/**
 * Learn on the phone: the same deck, thumb-sized, in the phone's grammar. The card names its source the
 * way a message names its author — the agent's face and name, the conversation, when — then the front,
 * one button for the answer, then Again or Got it side by side, each with its next gap; Delete and Undo
 * delete underneath. The pass is held by Phone.tsx, so opening Learn from Home or More resumes it; Back
 * returns to where it was opened from.
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
            <p className="loki-phone-empty">Loading the cards…</p>
          ) : !current && cards.length === 0 && !recall.snap.worker.enabled ? (
            <RecallIntro worker={recall.snap.worker} />
          ) : !current ? (
            <Rest cards={cards.length} passed={pass.passed.size} nextDue={pass.nextDue} />
          ) : (
            <PhoneCard
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

function PhoneCard({ c, position, total, revealed, onReveal, onAnswer, onDelete, onUndo }: { c: CardWithSchedule; position: number; total: number; revealed: boolean; onReveal: () => void; onAnswer: (g: Grade) => void; onDelete: () => void; onUndo: () => void }) {
  const gaps = previews(c.schedule);
  return (
    <section aria-label={`card ${position} of ${total}`} className="loki-phone-learn-card">
      <Source c={c} />
      <div className="loki-phone-learn-front">{c.card.front}</div>
      {revealed ? (
        <div className="loki-phone-learn-back">{c.card.back}</div>
      ) : (
        <Button size="touch" tone="paper" block onClick={onReveal}>
          Show the answer
        </Button>
      )}
      {revealed && (
        <div className="loki-phone-learn-grades">
          {ANSWERS.map(({ grade, label }) => (
            <button key={grade} type="button" className={grade >= 3 ? "loki-phone-decide-btn loki-phone-decide-btn--affirm" : "loki-phone-decide-btn"} aria-label={`${label}, next in ${gaps[grade]}`} onClick={() => onAnswer(grade)}>
              <span className="loki-phone-learn-grade">{label[0].toUpperCase() + label.slice(1)}</span>
              <span className="loki-phone-learn-gap">{gaps[grade]}</span>
            </button>
          ))}
        </div>
      )}
      <div className="loki-phone-learn-foot">
        <Button size="touch" tone="negative" onClick={onDelete}>
          Delete card
        </Button>
        <Button size="touch" onClick={onUndo}>
          Undo delete
        </Button>
      </div>
    </section>
  );
}
