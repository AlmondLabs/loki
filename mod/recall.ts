import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { newSchedule, review, type Grade, type Schedule } from "../packages/core/src/recall/fsrs.ts";
import type { Card, CardWithSchedule, Rejected, WorkerStatus } from "../packages/core/src/recall/model.ts";

/**
 * The Recall files, under ~/.letta/loki/recall (LOKI_RECALL_DIR in tests):
 *   cards/<id>.json      the text and its source — the worker's to write and update
 *   schedule/<id>.json   the person's review history (FSRS state) — never touched by the worker
 *   rejected/<id>.json   deleted cards, kept as negative examples the worker reads before writing
 *   worker.json          the worker's settings, its per-conversation cursors and its last run
 * One file per card so an agent, a person or a sync tool can read and edit any of it by hand.
 */
export const recallDir = (): string => process.env.LOKI_RECALL_DIR ?? join(homedir(), ".letta", "loki", "recall");

interface WorkerFile {
  enabled: boolean;
  model: string | null;
  dailyCap: number;
  lastRunAt: string | null;
  lastRunNote: string | null;
  /** ISO day ("2026-09-10") the count belongs to, and the count. */
  written: { day: string; count: number };
  /** Per conversation ("agentId/conversationId"): how many transcript lines the worker has already read. */
  cursors: Record<string, number>;
  /** Per agent: the hidden conversation the worker asks its questions in. */
  recallConversations?: Record<string, string>;
}
const WORKER_DEFAULTS: WorkerFile = { enabled: true, model: null, dailyCap: 10, lastRunAt: null, lastRunNote: null, written: { day: "", count: 0 }, cursors: {}, recallConversations: {} };

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}
function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n");
  renameSync(`${path}.tmp`, path);
}
function listJson<T>(dir: string): T[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return names.map((f) => readJson<T>(join(dir, f))).filter((v): v is T => v !== null);
}
const isoDay = (now: number) => new Date(now).toISOString().slice(0, 10);

export function newCardId(now = Date.now()): string {
  return `${new Date(now).toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Everything Recall keeps, read fresh from disk on each call — the files are small and may be edited by hand. */
export class RecallStore {
  readonly dir: string;
  constructor(dir = recallDir()) {
    this.dir = dir;
  }

  private p = (...parts: string[]) => join(this.dir, ...parts);

  cards(): CardWithSchedule[] {
    return listJson<Card>(this.p("cards"))
      .filter((c) => typeof c.id === "string" && typeof c.front === "string" && typeof c.back === "string")
      .map((card) => ({ card, schedule: readJson<Schedule>(this.p("schedule", `${card.id}.json`)) ?? newSchedule(new Date(card.createdAt).getTime() || Date.now()) }))
      .sort((a, b) => a.card.createdAt.localeCompare(b.card.createdAt));
  }

  card(id: string): CardWithSchedule | null {
    const card = readJson<Card>(this.p("cards", `${id}.json`));
    if (!card) return null;
    return { card, schedule: readJson<Schedule>(this.p("schedule", `${id}.json`)) ?? newSchedule() };
  }

  rejected(): Rejected[] {
    return listJson<Rejected>(this.p("rejected")).sort((a, b) => b.at.localeCompare(a.at));
  }

  /** A new card from the worker (or a restore). The schedule starts fresh: due now, unreviewed. */
  add(card: Card, schedule?: Schedule): void {
    writeJson(this.p("cards", `${card.id}.json`), card);
    writeJson(this.p("schedule", `${card.id}.json`), schedule ?? newSchedule(new Date(card.createdAt).getTime() || Date.now()));
  }

  /** New text for a card; the old wording goes into `previous`. The schedule is untouched. Returns the card, or null when unknown. */
  edit(id: string, text: { front?: string; back?: string; tags?: string[] }, by: "recall" | "you", now = Date.now()): Card | null {
    const cur = readJson<Card>(this.p("cards", `${id}.json`));
    if (!cur) return null;
    const front = text.front?.trim() || cur.front;
    const back = text.back?.trim() || cur.back;
    const tags = text.tags ?? cur.tags;
    const changedText = front !== cur.front || back !== cur.back;
    const next: Card = {
      ...cur,
      front,
      back,
      tags,
      ...(changedText ? { updatedAt: new Date(now).toISOString(), updatedBy: by, previous: [...cur.previous, { front: cur.front, back: cur.back, at: cur.updatedAt, by: cur.updatedBy }].slice(-5) } : {}),
    };
    writeJson(this.p("cards", `${id}.json`), next);
    return next;
  }

  /** A review: the FSRS step, recorded on the schedule file only. */
  grade(id: string, grade: Grade, now = Date.now()): Schedule | null {
    const cur = this.card(id);
    if (!cur) return null;
    const next = review(cur.schedule, grade, now);
    writeJson(this.p("schedule", `${id}.json`), next);
    return next;
  }

  /** Delete: the card moves to the rejected pile with how far it had got. That pile is the worker's negative examples. */
  reject(id: string, now = Date.now()): Rejected | null {
    const cur = this.card(id);
    if (!cur) return null;
    const rec: Rejected = { card: cur.card, at: new Date(now).toISOString(), reps: cur.schedule.reps };
    writeJson(this.p("rejected", `${id}.json`), rec);
    rmSync(this.p("cards", `${id}.json`), { force: true });
    rmSync(this.p("schedule", `${id}.json`), { force: true });
    return rec;
  }

  /** Undo a delete: the card comes back with a fresh schedule (its history went with the delete). */
  restore(id: string): Card | null {
    const rec = readJson<Rejected>(this.p("rejected", `${id}.json`));
    if (!rec) return null;
    this.add(rec.card);
    rmSync(this.p("rejected", `${id}.json`), { force: true });
    return rec.card;
  }

  /** Drop a rejection for good (the pile is otherwise kept: it is what teaches the worker). */
  forget(id: string): void {
    rmSync(this.p("rejected", `${id}.json`), { force: true });
  }

  worker(): WorkerFile {
    const file = readJson<Partial<WorkerFile>>(this.p("worker.json")) ?? {};
    return { ...WORKER_DEFAULTS, ...file, cursors: { ...(file.cursors ?? {}) }, recallConversations: { ...(file.recallConversations ?? {}) } };
  }
  saveWorker(update: Partial<WorkerFile>): WorkerFile {
    const next = { ...this.worker(), ...update };
    writeJson(this.p("worker.json"), next);
    return next;
  }
  /** Cards written today against the cap; the day rolls over on its own. */
  writtenToday(now = Date.now()): number {
    const w = this.worker();
    return w.written.day === isoDay(now) ? w.written.count : 0;
  }
  noteWritten(n: number, now = Date.now()): void {
    const day = isoDay(now);
    const w = this.worker();
    this.saveWorker({ written: { day, count: (w.written.day === day ? w.written.count : 0) + n } });
  }
  status(now = Date.now()): WorkerStatus {
    const w = this.worker();
    return { enabled: w.enabled, model: w.model, dailyCap: w.dailyCap, lastRunAt: w.lastRunAt, lastRunNote: w.lastRunNote, writtenToday: this.writtenToday(now) };
  }

  exists(): boolean {
    return existsSync(this.dir);
  }
}
