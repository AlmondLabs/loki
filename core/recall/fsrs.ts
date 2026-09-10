/**
 * FSRS-4.5, the scheduler modern Anki uses, as pure functions over a small state. A card is a pair of
 * numbers — stability (the days until recall drops to 90%) and difficulty (1–10) — plus its due time.
 * Four grades per review: 1 again · 2 hard · 3 good · 4 easy. Nothing here reads a clock or a file;
 * the caller passes `now` and keeps the state.
 */
export type Grade = 1 | 2 | 3 | 4;
export const GRADES: Array<{ grade: Grade; label: string }> = [
  { grade: 1, label: "again" },
  { grade: 2, label: "hard" },
  { grade: 3, label: "good" },
  { grade: 4, label: "easy" },
];
/** What the deck offers: two answers, on the arrow keys. "again" is grade 1, "got it" is grade 3; the scheduler keeps its four internally. */
export const ANSWERS: Array<{ grade: Grade; label: string; key: string }> = [
  { grade: 1, label: "again", key: "←" },
  { grade: 3, label: "got it", key: "→" },
];

export interface Schedule {
  /** Days until retrievability falls to 90%. 0 until the first review. */
  stability: number;
  /** 1 (easy material) to 10 (hard). 0 until the first review. */
  difficulty: number;
  /** ISO time the card is next due. A new card is due at once. */
  due: string;
  /** ISO time of the last review; null for a new card. */
  lastReview: string | null;
  reps: number;
  /** Times the card was forgotten (graded again) after having been learned. */
  lapses: number;
  /** The last few grades, newest last, for spotting a card that keeps failing. */
  recent: Grade[];
}

/** FSRS-4.5 default parameters. */
export const W = [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755];
const DECAY = -0.5;
const FACTOR = 19 / 81;
/** The retention the intervals aim for. */
export const REQUESTED_RETENTION = 0.9;
export const MAX_INTERVAL_DAYS = 365;
/** A forgotten card comes back within the sitting rather than tomorrow. */
export const RELEARN_MINUTES = 10;
const DAY = 86_400_000;

export function newSchedule(now = Date.now()): Schedule {
  return { stability: 0, difficulty: 0, due: new Date(now).toISOString(), lastReview: null, reps: 0, lapses: 0, recent: [] };
}

/** Probability of recall after `elapsedDays` at stability `s`. */
export function retrievability(s: Schedule, now = Date.now()): number {
  if (!s.lastReview || s.stability <= 0) return 0;
  const days = Math.max(0, (now - new Date(s.lastReview).getTime()) / DAY);
  return Math.pow(1 + (FACTOR * days) / s.stability, DECAY);
}

/** Days until recall falls to the requested retention, at stability `stability`. Whole days, at least one. */
export function intervalDays(stability: number, retention = REQUESTED_RETENTION): number {
  const days = (stability / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);
  return Math.min(MAX_INTERVAL_DAYS, Math.max(1, Math.round(days)));
}

const clampD = (d: number) => Math.min(10, Math.max(1, d));
const initialStability = (g: Grade) => W[g - 1];
const initialDifficulty = (g: Grade) => clampD(W[4] - (g - 3) * W[5]);

function nextDifficulty(d: number, g: Grade): number {
  const moved = d - W[6] * (g - 3);
  return clampD(W[7] * initialDifficulty(3) + (1 - W[7]) * moved); // mean reversion toward a "good" first answer
}
function nextRecallStability(d: number, s: number, r: number, g: Grade): number {
  const hard = g === 2 ? W[15] : 1;
  const easy = g === 4 ? W[16] : 1;
  return s * (Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) * hard * easy + 1);
}
function nextForgetStability(d: number, s: number, r: number): number {
  return Math.min(s, W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r)));
}

/** The state after grading the card now. */
export function review(s: Schedule, grade: Grade, now = Date.now()): Schedule {
  const at = new Date(now).toISOString();
  const recent = [...s.recent, grade].slice(-5);
  const first = !s.lastReview || s.stability <= 0;
  let stability: number;
  let difficulty: number;
  let lapses = s.lapses;
  if (first) {
    stability = initialStability(grade);
    difficulty = initialDifficulty(grade);
  } else {
    const r = retrievability(s, now);
    difficulty = nextDifficulty(s.difficulty, grade);
    if (grade === 1) {
      stability = nextForgetStability(s.difficulty, s.stability, r);
      lapses += 1;
    } else {
      stability = nextRecallStability(s.difficulty, s.stability, r, grade);
    }
  }
  const due = grade === 1 ? new Date(now + RELEARN_MINUTES * 60_000).toISOString() : new Date(now + intervalDays(stability) * DAY).toISOString();
  return { stability, difficulty, due, lastReview: at, reps: s.reps + 1, lapses, recent };
}

/** What each grade would schedule from here — for showing "1d · 4d · 10d" under the buttons. */
export function previews(s: Schedule, now = Date.now()): Record<Grade, string> {
  const out = {} as Record<Grade, string>;
  for (const { grade } of GRADES) out[grade] = describeGap(new Date(review(s, grade, now).due).getTime() - now);
  return out;
}

/** "10m", "1d", "3w", "4mo". */
export function describeGap(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const d = Math.round(ms / DAY);
  if (d < 1) return `${Math.round(m / 60)}h`;
  if (d < 14) return `${d}d`;
  if (d < 60) return `${Math.round(d / 7)}w`;
  return `${Math.round(d / 30)}mo`;
}

export const isDue = (s: Schedule, now = Date.now()) => new Date(s.due).getTime() <= now;
export const isNew = (s: Schedule) => s.lastReview === null;

/** A card the scheduler cannot hold: three of the last four answers were "again". The worker rewrites or splits it. */
export function keepsFailing(s: Schedule): boolean {
  const last = s.recent.slice(-4);
  return last.length >= 3 && last.filter((g) => g === 1).length >= 3;
}
