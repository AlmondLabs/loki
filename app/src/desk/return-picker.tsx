import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button, Field, Meta, Row } from "../components";

/** The furthest a card put off twice can be sent: about a month, so nothing is put off out of mind (plan 070, R7). */
export const LATER_MAX_DAYS = 31;

/** The hour a card picked for a later day comes back at: the start of a working morning, local time. */
const MORNING = 9;

/** One return time the picker offers: its id, its words, and when the card comes back. */
export interface ReturnChoice {
  id: "today" | "tomorrow" | "days" | "week";
  label: string;
  at: Date;
}

/** `now`'s day plus `days`, at the morning hour, local time. */
const morning = (now: Date, days: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, MORNING, 0);

/** The return times the second ⌘[ offers, from `now`: in 3 hours, tomorrow morning, in 3 days, and a week on. */
export function returnChoices(now: Date): ReturnChoice[] {
  return [
    { id: "today", label: "later today", at: new Date(now.getTime() + 3 * 3_600_000) },
    { id: "tomorrow", label: "tomorrow", at: morning(now, 1) },
    { id: "days", label: "in 3 days", at: morning(now, 3) },
    { id: "week", label: "next week", at: morning(now, 7) },
  ];
}

/** A date typed or picked ("2026-11-20") as that morning, local time; null when empty, not after today, or past the bound. */
export function dateChoice(value: string, now: Date): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), MORNING, 0);
  if (at.getTime() < morning(now, 1).getTime() || at.getTime() > morning(now, LATER_MAX_DAYS).getTime()) return null;
  return at;
}

/** A local date as the date input takes it ("2026-11-20"). */
const dateValue = (d: Date) => `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** When a choice comes back, in the meta's short words: "17:30", "Fri 9:00". */
const whenText = (at: Date, now: Date) =>
  at.toDateString() === now.toDateString()
    ? at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : at.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/**
 * When a card put off twice should come back (plan 070, R7): the second ⌘[ on the same card asks here. Arrows move,
 * Enter or a click picks, a date goes up to about a month on, and Esc closes with nothing scheduled. Drawn in the card
 * above its moves, as the hand-off picker is.
 */
export function ReturnPicker({ onPick, onCancel }: { onPick: (at: Date) => void; onCancel: () => void }) {
  const [now] = useState(() => new Date());
  const choices = returnChoices(now);
  const [hi, setHi] = useState(0);
  const [date, setDate] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  // The list takes focus as it opens, so Enter picks at once.
  useEffect(() => listRef.current?.focus({ preventScroll: true }), []);
  const picked = dateChoice(date, now);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // The deck's own keys wait while the picker is open.
    e.stopPropagation();
    const inDate = e.target instanceof HTMLInputElement;
    if (e.key === "Escape") onCancel();
    else if (e.key === "Enter" && inDate) {
      if (picked) onPick(picked);
    } else if (inDate) return;
    else if (e.key === "ArrowDown") setHi((i) => Math.min(i + 1, choices.length - 1));
    else if (e.key === "ArrowUp") setHi((i) => Math.max(i - 1, 0));
    else if (e.key === "Enter") onPick(choices[hi].at);
    else return;
    e.preventDefault();
  };

  return (
    <div role="dialog" aria-label="when should it come back" onKeyDown={onKey} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <Meta>when should it come back</Meta>
      <div
        ref={listRef}
        role="listbox"
        tabIndex={0}
        aria-label="return times"
        aria-activedescendant={`return-option-${choices[hi].id}`}
        style={{ display: "flex", flexDirection: "column" }}
      >
        {choices.map((c, i) => (
          <Row
            key={c.id}
            id={`return-option-${c.id}`}
            role="option"
            tabIndex={-1}
            dense
            selected={i === hi}
            aria-selected={i === hi}
            onMouseEnter={() => setHi(i)}
            onClick={() => onPick(c.at)}
            style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}
          >
            <span style={{ fontSize: 13.5 }}>{c.label}</span>
            <Meta>{whenText(c.at, now)}</Meta>
          </Row>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Meta>a date</Meta>
        <Field
          type="date"
          size="sm"
          value={date}
          min={dateValue(choices[1].at)}
          max={dateValue(new Date(now.getFullYear(), now.getMonth(), now.getDate() + LATER_MAX_DAYS))}
          onChange={(e) => setDate(e.target.value)}
          aria-label="a date"
        />
        {date && !picked && <Meta negative>pick a day from tomorrow to {String(LATER_MAX_DAYS)} days on</Meta>}
        {picked && (
          <Button size="sm" tone="paper" onClick={() => onPick(picked)}>
            pick
          </Button>
        )}
      </div>
    </div>
  );
}
