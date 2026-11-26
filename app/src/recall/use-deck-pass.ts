import { useMemo, useState } from "react";
import { reviewQueue, type CardWithSchedule } from "../../../core/recall/model.ts";

export function useDeckPass(cards: CardWithSchedule[]) {
  const [passed, setPassed] = useState<Set<string>>(() => new Set());
  const [away, setAway] = useState<Set<string>>(() => new Set());
  const next = returned(passed, away, cards);
  if (next) {
    setPassed(next.passed);
    setAway(next.away);
  }
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const queue = useMemo(() => reviewQueue(cards).filter((c) => !passed.has(c.card.id)), [cards, passed]);
  const current = queue.find((c) => c.card.id === currentId) ?? queue.at(0);
  const revealed = !!current && revealedId === current.card.id;
  const reveal = () => current && setRevealedId(current.card.id);
  const advance = (id?: string) => {
    const targetId = id ?? current?.card.id;
    const card = queue.find((c) => c.card.id === targetId);
    if (!card) return;
    const next = nextInDeck(queue, card, chosenId === card.card.id || card !== current);
    setPassed((p) => new Set(p).add(card.card.id));
    setCurrentId(next?.card.id ?? null);
    setChosenId(null);
  };
  const choose = (id: string) => {
    if (!queue.some((c) => c.card.id === id)) return;
    setCurrentId(id);
    setChosenId(id);
    setRevealedId(null);
  };
  const total = queue.length + passed.size;
  const nextDue = cards
    .filter((c) => !passed.has(c.card.id) && !queue.includes(c))
    .map((c) => new Date(c.schedule.due).getTime())
    .sort()[0];
  return { queue, current, revealed, reveal, advance, choose, passed, total, nextDue };
}

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

export function nextInDeck(queue: readonly CardWithSchedule[], current: CardWithSchedule, chosen: boolean): CardWithSchedule | undefined {
  const first = queue.find((c) => c !== current);
  return chosen ? first : (queue.at(queue.indexOf(current) + 1) ?? first);
}
