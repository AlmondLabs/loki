import type { ReactNode } from "react";
import { useNow } from "../ui/useNow";
import { ANSWERS, describeGap, previews, type Grade } from "../../../packages/core/src/recall/fsrs.ts";
import type { CardWithSchedule } from "../../../packages/core/src/recall/model.ts";
import type { Recall as RecallModel } from "../shell/useRecall";
import { SourceLine } from "../recall/RecallParts";
import { useDeckPass } from "../recall/useDeckPass";
import { Button, Empty, Meta } from "../ui";
import { GUTTER, Scroll, TopBar } from "./ui";

/**
 * Recall on the phone: the same deck, thumb-sized. The front, one button for the answer, then again or
 * got it side by side; delete and undo underneath. Where most reviewing happens, so it is the whole tab.
 */
const TONE: Record<Grade, "negative" | "quiet" | "paper" | "positive"> = { 1: "negative", 2: "quiet", 3: "positive", 4: "positive" };

export function Recall({ recall, banner }: { recall: RecallModel; banner: ReactNode }) {
  const cards = recall.snap?.cards ?? [];
  const pass = useDeckPass(cards);
  const { current } = pass;
  return (
    <>
      <TopBar title="recall" sub={`${recall.due} due · ${cards.length} card${cards.length === 1 ? "" : "s"}`} progress={pass.total ? pass.passed.size / pass.total : null} />
      {banner}
      <Scroll style={{ padding: `16px ${GUTTER.right} 24px ${GUTTER.left}` }}>
        {!recall.snap ? <Meta>loading…</Meta> : !current ? <Rest cards={cards.length} passed={pass.passed.size} nextDue={pass.nextDue} /> : (
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
      </Scroll>
    </>
  );
}

/** No card to show: none written yet, none due, or the sitting is done. */
function Rest({ cards, passed, nextDue }: { cards: number; passed: number; nextDue: number | undefined }) {
  const now = useNow();
  if (cards === 0) return <Empty card title="Nothing to recall yet.">Cards are written in the background from conversations that have gone quiet.</Empty>;
  return <Empty card title={passed ? "Done for now." : "Nothing due."}>{nextDue ? `The next one is due in ${describeGap(nextDue - now)}.` : ""}</Empty>;
}

function PhoneCard({ c, position, total, revealed, onReveal, onAnswer, onDelete, onUndo }: { c: CardWithSchedule; position: number; total: number; revealed: boolean; onReveal: () => void; onAnswer: (g: Grade) => void; onDelete: () => void; onUndo: () => void }) {
  const gaps = previews(c.schedule);
  return (
    <section aria-label={`card ${position} of ${total}`} style={{ background: "var(--loki-panel)", border: "1px solid var(--loki-border)", borderRadius: 12, padding: "16px 18px", display: "grid", gap: 14 }}>
      <SourceLine c={c} />
      <div style={{ fontFamily: "var(--loki-display)", fontSize: 22, lineHeight: 1.3, color: "var(--loki-fg)", whiteSpace: "pre-wrap", padding: "6px 0" }}>{c.card.front}</div>
      {revealed ? (
        <div style={{ borderTop: "1px solid var(--loki-border)", paddingTop: 12, fontSize: 15, lineHeight: 1.55, color: "var(--loki-fg)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{c.card.back}</div>
      ) : (
        <Button size="touch" tone="paper" block onClick={onReveal}>show the answer</Button>
      )}
      {revealed && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
          {ANSWERS.map(({ grade, label }) => (
            <Button key={grade} size="touch" tone={TONE[grade]} onClick={() => onAnswer(grade)} style={{ flexDirection: "column", gap: 2, padding: "6px 4px" }}>
              <span>{label}</span>
              <span style={{ fontSize: 10.5, opacity: 0.75, fontFamily: "var(--loki-mono)" }}>{gaps[grade]}</span>
            </Button>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
        <Button size="sm" onClick={onDelete}>delete</Button>
        <Button size="sm" onClick={onUndo}>undo delete</Button>
      </div>
    </section>
  );
}
