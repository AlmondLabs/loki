import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ANSWERS, describeGap, previews, type Grade } from "../../../packages/core/src/recall/fsrs.ts";
import { reviewQueue } from "../../../packages/core/src/recall/model.ts";
import type { Recall as RecallModel } from "../shell/useRecall";
import { SourceLine } from "../recall/RecallParts";
import { Button, Empty, Meta } from "../ui";
import { GUTTER, Scroll, TopBar } from "./ui";

/**
 * Recall on the phone: the same deck, thumb-sized. The front, one button for the answer, then again or
 * got it side by side; delete and undo underneath. Where most reviewing happens, so it is the whole tab.
 */
const TONE: Record<Grade, "negative" | "quiet" | "paper" | "positive"> = { 1: "negative", 2: "quiet", 3: "positive", 4: "positive" };

export function Recall({ recall, banner }: { recall: RecallModel; banner: ReactNode }) {
  const cards = recall.snap?.cards ?? [];
  const [passed, setPassed] = useState<Set<string>>(() => new Set());
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const queue = useMemo(() => reviewQueue(cards).filter((c) => !passed.has(c.card.id)), [cards, passed]);
  const current = queue.find((c) => c.card.id === currentId) ?? queue[0];
  useEffect(() => {
    if (current?.card.id !== currentId) {
      setCurrentId(current?.card.id ?? null);
      setRevealed(false);
    }
  }, [current?.card.id, currentId]);
  const advance = () => current && setPassed((p) => new Set(p).add(current.card.id));
  const total = queue.length + passed.size;
  const nextDue = cards.filter((c) => !passed.has(c.card.id) && !queue.includes(c)).map((c) => new Date(c.schedule.due).getTime()).sort()[0];
  return (
    <>
      <TopBar title="recall" sub={`${recall.due} due · ${cards.length} card${cards.length === 1 ? "" : "s"}`} progress={total ? passed.size / total : null} />
      {banner}
      <Scroll style={{ padding: `16px ${GUTTER.right} 24px ${GUTTER.left}` }}>
        {!recall.snap ? (
          <Meta>loading…</Meta>
        ) : cards.length === 0 ? (
          <Empty card title="Nothing to recall yet.">Cards are written in the background from conversations that have gone quiet.</Empty>
        ) : !current ? (
          <Empty card title={passed.size ? "Done for now." : "Nothing due."}>{nextDue ? `The next one is due in ${describeGap(nextDue - Date.now())}.` : ""}</Empty>
        ) : (
          <section aria-label={`card ${passed.size + 1} of ${total}`} style={{ background: "var(--loki-panel)", border: "1px solid var(--loki-border)", borderRadius: 12, padding: "16px 18px", display: "grid", gap: 14 }}>
            <SourceLine c={current} />
            <div style={{ fontFamily: "var(--loki-display)", fontSize: 22, lineHeight: 1.3, color: "var(--loki-fg)", whiteSpace: "pre-wrap", padding: "6px 0" }}>{current.card.front}</div>
            {revealed ? (
              <div style={{ borderTop: "1px solid var(--loki-border)", paddingTop: 12, fontSize: 15, lineHeight: 1.55, color: "var(--loki-fg)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{current.card.back}</div>
            ) : (
              <Button size="touch" tone="paper" block onClick={() => setRevealed(true)}>show the answer</Button>
            )}
            {revealed && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
                {ANSWERS.map(({ grade, label }) => (
                  <Button key={grade} size="touch" tone={TONE[grade]} onClick={() => { void recall.grade(current.card.id, grade); advance(); }} style={{ flexDirection: "column", gap: 2, padding: "6px 4px" }}>
                    <span>{label}</span>
                    <span style={{ fontSize: 10.5, opacity: 0.75, fontFamily: "var(--loki-mono)" }}>{previews(current.schedule)[grade]}</span>
                  </Button>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
              <Button size="sm" onClick={() => { void recall.remove(current.card.id); advance(); }}>delete</Button>
              <Button size="sm" onClick={() => void recall.undo()}>undo delete</Button>
            </div>
          </section>
        )}
      </Scroll>
    </>
  );
}
