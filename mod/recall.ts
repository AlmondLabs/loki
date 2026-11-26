import { lokiDir } from "./paths.ts";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { newSchedule, review, type Grade, type Schedule } from "../core/recall/fsrs.ts";
import { isRecallId, type Card, type CardWithSchedule, type DismissedLead, type Lead, type Lesson, type Rejected } from "../core/recall/model.ts";
import { writeJsonAtomic } from "./json-file.ts";

export const recallDir = (): string => process.env.LOKI_RECALL_DIR ?? join(lokiDir(), "recall");

const writeJson = (path: string, value: unknown) => writeJsonAtomic(path, value, { pretty: true, newline: true });
export const isoDay = (now: number): string => {
  const d = new Date(now);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
};

export function newCardId(now = Date.now()): string {
  return `${new Date(now).toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 8)}`;
}

export class RecallStore {
  readonly dir: string;
  private readonly fileCache = new Map<string, { mtimeMs: number; size: number; value: unknown }>();

  constructor(dir = recallDir()) {
    this.dir = dir;
  }

  private p = (...parts: string[]) => join(this.dir, ...parts);
  private f = (kind: string, id: unknown) => {
    if (!isRecallId(id)) throw new Error(`not a card or lead id: ${String(id).slice(0, 80)}`);
    return join(this.dir, kind, `${id}.json`);
  };

  private readCached(file: string): unknown {
    try {
      const st = statSync(file);
      const cached = this.fileCache.get(file);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.value;
      const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (value === null || typeof value !== "object") {
        this.fileCache.delete(file);
        return null;
      }
      this.fileCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
      return value;
    } catch {
      this.fileCache.delete(file);
      return null;
    }
  }

  private writeCached(file: string, value: unknown): void {
    writeJson(file, value);
    try {
      const st = statSync(file);
      this.fileCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
    } catch {
      this.fileCache.delete(file);
    }
  }

  private removeCached(file: string): void {
    rmSync(file, { force: true });
    this.fileCache.delete(file);
  }

  private listJson<T>(dir: string): T[] {
    let names: string[];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      const prefix = `${dir}${sep}`;
      for (const k of [...this.fileCache.keys()]) if (k.startsWith(prefix)) this.fileCache.delete(k);
      return [];
    }
    const seen = new Set<string>();
    const out: T[] = [];
    for (const f of names) {
      const full = join(dir, f);
      seen.add(full);
      const v = this.readCached(full) as T | null;
      if (v !== null) out.push(v);
    }
    const prefix = `${dir}${sep}`;
    for (const k of [...this.fileCache.keys()]) if (k.startsWith(prefix) && !seen.has(k)) this.fileCache.delete(k);
    return out;
  }

  cards(): CardWithSchedule[] {
    return this.listJson<Card>(this.p("cards"))
      .filter((c) => isRecallId(c.id) && typeof c.front === "string" && typeof c.back === "string")
      .map((card) => ({
        card,
        schedule: (this.readCached(this.f("schedule", card.id)) as Schedule | null) ?? newSchedule(new Date(card.created_at).getTime() || Date.now()),
      }))
      .sort((a, b) => a.card.created_at.localeCompare(b.card.created_at));
  }

  card(id: string): CardWithSchedule | null {
    const card = this.readCached(this.f("cards", id)) as Card | null;
    if (!card) return null;
    return { card, schedule: (this.readCached(this.f("schedule", id)) as Schedule | null) ?? newSchedule() };
  }

  rejected(): Rejected[] {
    return this.listJson<Rejected>(this.p("rejected")).sort((a, b) => b.at.localeCompare(a.at));
  }

  add(card: Card, schedule?: Schedule): void {
    this.writeCached(this.f("cards", card.id), card);
    this.writeCached(this.f("schedule", card.id), schedule ?? newSchedule(new Date(card.created_at).getTime() || Date.now()));
  }

  edit(id: string, text: { front?: string; back?: string; tags?: string[] }, by: "recall" | "you", now = Date.now()): Card | null {
    const cur = this.readCached(this.f("cards", id)) as Card | null;
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
      ...(changedText
        ? {
            updated_at: new Date(now).toISOString(),
            updated_by: by,
            previous: [...cur.previous, { front: cur.front, back: cur.back, at: cur.updated_at, by: cur.updated_by }].slice(-5),
          }
        : {}),
    };
    this.writeCached(this.f("cards", id), next);
    return next;
  }

  grade(id: string, grade: Grade, now = Date.now()): Schedule | null {
    const cur = this.card(id);
    if (!cur) return null;
    const next = review(cur.schedule, grade, now);
    this.writeCached(this.f("schedule", id), next);
    return next;
  }

  reject(id: string, now = Date.now()): Rejected | null {
    const cur = this.card(id);
    if (!cur) return null;
    const rec: Rejected = { card: cur.card, at: new Date(now).toISOString(), reps: cur.schedule.reps };
    this.writeCached(this.f("rejected", id), rec);
    this.removeCached(this.f("cards", id));
    this.removeCached(this.f("schedule", id));
    return rec;
  }

  restore(id: string): Card | null {
    const card = (this.readCached(this.f("rejected", id)) as Partial<Rejected> | null)?.card;
    if (!card || !isRecallId(card.id)) return null;
    this.add(card);
    this.removeCached(this.f("rejected", id));
    return card;
  }

  forget(id: string): void {
    this.removeCached(this.f("rejected", id));
  }

  leads(): Lead[] {
    return this.listJson<Lead>(this.p("leads"))
      .filter((l) => isRecallId(l.id) && typeof l.title === "string" && typeof l.why === "string")
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  lead(id: string): Lead | null {
    return this.readCached(this.f("leads", id)) as Lead | null;
  }
  addLead(lead: Lead): void {
    this.writeCached(this.f("leads", lead.id), lead);
  }
  dismissedLeads(): DismissedLead[] {
    return this.listJson<DismissedLead>(this.p("leads-dismissed")).sort((a, b) => b.at.localeCompare(a.at));
  }
  dismissLead(id: string, now = Date.now()): DismissedLead | null {
    const lead = this.lead(id);
    if (!lead) return null;
    const rec: DismissedLead = { lead, at: new Date(now).toISOString() };
    this.writeCached(this.f("leads-dismissed", id), rec);
    this.removeCached(this.f("leads", id));
    return rec;
  }
  restoreLead(id: string): Lead | null {
    const lead = (this.readCached(this.f("leads-dismissed", id)) as Partial<DismissedLead> | null)?.lead;
    if (!lead || !isRecallId(lead.id)) return null;
    this.addLead(lead);
    this.removeCached(this.f("leads-dismissed", id));
    return lead;
  }
  lessons(): Lesson[] {
    return this.listJson<Lesson>(this.p("lessons")).sort((a, b) => b.started_at.localeCompare(a.started_at));
  }
  startLesson(id: string, conversation: { agentId: string; conversationId: string }, now = Date.now()): Lesson | null {
    const lead = this.lead(id);
    if (!lead) return null;
    const lesson: Lesson = { lead, agent_id: conversation.agentId, conversation_id: conversation.conversationId, started_at: new Date(now).toISOString() };
    this.writeCached(this.f("lessons", id), lesson);
    this.removeCached(this.f("leads", id));
    return lesson;
  }

  exists(): boolean {
    return existsSync(this.dir);
  }
}
