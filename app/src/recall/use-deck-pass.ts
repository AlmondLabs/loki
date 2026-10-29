import { useMemo, useState } from "react";
import { reviewQueue, type CardWithSchedule } from "../../../core/recall/model.ts";

/**
 * One sitting with the deck, shared by the desktop section and the phone tab: the queue of due cards
 * minus the ones answered this sitting, the card under your hands (it stays put while the list
 * refreshes; a refetch never pulls a different card in front of you), whether its answer shows, and the
 * move to the next one. Everything is keyed by card id, so a card leaving the queue takes its state with it.
 */
export function useDeckPass(cards: CardWithSchedule[]) {
  /** Cards answered or deleted this sitting: they leave the queue at once, whatever their new due time says. */
  const [passed, setPassed] = useState<Set<string>>(() => new Set());
  /** Passed cards no longer in the deck (deleted): one that comes back (undo, restore) is due again this sitting. */
  const [away, setAway] = useState<Set<string>>(() => new Set());
  const next = returned(passed, away, cards);
  if (next) {
    setPassed(next.passed);
    setAway(next.away);
  }
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const queue = useMemo(() => reviewQueue(cards).filter((c) => !passed.has(c.card.id)), [cards, passed]);
  const current = queue.find((c) => c.card.id === currentId) ?? queue.at(0);
  const revealed = !!current && revealedId === current.card.id;
  const reveal = () => current && setRevealedId(current.card.id);
  /** Leave the current card behind; the one after it in the queue is next. */
  const advance = () => {
    if (!current) return;
    const next = queue.at(queue.indexOf(current) + 1) ?? queue.find((c) => c !== current);
    setPassed((p) => new Set(p).add(current.card.id));
    setCurrentId(next?.card.id ?? null);
  };
  const total = queue.length + passed.size;
  /** When the next card not yet due comes due, for the "done for now" note. */
  const nextDue = cards
    .filter((c) => !passed.has(c.card.id) && !queue.includes(c))
    .map((c) => new Date(c.schedule.due).getTime())
    .sort()[0];
  return { queue, current, revealed, reveal, advance, passed, total, nextDue };
}

/**
 * The passed cards that went from the deck (deleted) and came back (undo, restore): they leave `passed`, so the card is
 * in the queue again. Null when nothing changed, which is what keeps the render from setting state again.
 */
export function returned(
  passed: ReadonlySet<string>,
  away: ReadonlySet<string>,
  cards: readonly CardWithSchedule[],
): { passed: Set<string>; away: Set<string> } | null {
  const present = new Set(cards.map((c) => c.card.id));
  const gone = [...passed].filter((id) => !present.has(id));
  const back = [...away].filter((id) => present.has(id));
  if (!back.length && gone.length === away.size && gone.every((id) => away.has(id))) return null;
  return { passed: new Set([...passed].filter((id) => !back.includes(id))), away: new Set(gone) };
}
