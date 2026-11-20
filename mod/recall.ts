import { lokiDir } from "./paths.ts";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { newSchedule, review, type Grade, type Schedule } from "../core/recall/fsrs.ts";
import { isRecallId, type Card, type CardWithSchedule, type DismissedLead, type Lead, type Lesson, type Rejected } from "../core/recall/model.ts";
import { readJson, writeJsonAtomic } from "./json-file.ts";

export const recallDir = (): string => process.env.LOKI_RECALL_DIR ?? join(lokiDir(), "recall");

const writeJson = (path: string, value: unknown) => writeJsonAtomic(path, value, { pretty: true, newline: true });
function listJson<T>(dir: string): T[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return names.map((f) => readJson(join(dir, f)) as T | null).filter((v): v is T => v !== null);
}
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
  constructor(dir = recallDir()) {
    this.dir = dir;
  }

  private p = (...parts: string[]) => join(this.dir, ...parts);
  private f = (kind: string, id: unknown) => {
    if (!isRecallId(id)) throw new Error(`not a card or lead id: ${String(id).slice(0, 80)}`);
    return join(this.dir, kind, `${id}.json`);
  };

  cards(): CardWithSchedule[] {
    return listJson<Card>(this.p("cards"))
      .filter((c) => isRecallId(c.id) && typeof c.front === "string" && typeof c.back === "string")
      .map((card) => ({
        card,
        schedule: (readJson(this.f("schedule", card.id)) as Schedule | null) ?? newSchedule(new Date(card.created_at).getTime() || Date.now()),
      }))
      .sort((a, b) => a.card.created_at.localeCompare(b.card.created_at));
  }

  card(id: string): CardWithSchedule | null {
    const card = readJson(this.f("cards", id)) as Card | null;
    if (!card) return null;
    return { card, schedule: (readJson(this.f("schedule", id)) as Schedule | null) ?? newSchedule() };
  }

  rejected(): Rejected[] {
    return listJson<Rejected>(this.p("rejected")).sort((a, b) => b.at.localeCompare(a.at));
  }

  add(card: Card, schedule?: Schedule): void {
    writeJson(this.f("cards", card.id), card);
    writeJson(this.f("schedule", card.id), schedule ?? newSchedule(new Date(card.created_at).getTime() || Date.now()));
  }

  edit(id: string, text: { front?: string; back?: string; tags?: string[] }, by: "recall" | "you", now = Date.now()): Card | null {
    const cur = readJson(this.f("cards", id)) as Card | null;
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
    writeJson(this.f("cards", id), next);
    return next;
  }

  grade(id: string, grade: Grade, now = Date.now()): Schedule | null {
    const cur = this.card(id);
    if (!cur) return null;
    const next = review(cur.schedule, grade, now);
    writeJson(this.f("schedule", id), next);
    return next;
  }

  reject(id: string, now = Date.now()): Rejected | null {
    const cur = this.card(id);
    if (!cur) return null;
    const rec: Rejected = { card: cur.card, at: new Date(now).toISOString(), reps: cur.schedule.reps };
    writeJson(this.f("rejected", id), rec);
    rmSync(this.f("cards", id), { force: true });
    rmSync(this.f("schedule", id), { force: true });
    return rec;
  }

  restore(id: string): Card | null {
    const card = (readJson(this.f("rejected", id)) as Partial<Rejected> | null)?.card;
    if (!card || !isRecallId(card.id)) return null;
    this.add(card);
    rmSync(this.f("rejected", id), { force: true });
    return card;
  }

  forget(id: string): void {
    rmSync(this.f("rejected", id), { force: true });
  }

  leads(): Lead[] {
    return listJson<Lead>(this.p("leads"))
      .filter((l) => isRecallId(l.id) && typeof l.title === "string" && typeof l.why === "string")
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  lead(id: string): Lead | null {
    return readJson(this.f("leads", id)) as Lead | null;
  }
  addLead(lead: Lead): void {
    writeJson(this.f("leads", lead.id), lead);
  }
  dismissedLeads(): DismissedLead[] {
    return listJson<DismissedLead>(this.p("leads-dismissed")).sort((a, b) => b.at.localeCompare(a.at));
  }
  dismissLead(id: string, now = Date.now()): DismissedLead | null {
    const lead = this.lead(id);
    if (!lead) return null;
    const rec: DismissedLead = { lead, at: new Date(now).toISOString() };
    writeJson(this.f("leads-dismissed", id), rec);
    rmSync(this.f("leads", id), { force: true });
    return rec;
  }
  restoreLead(id: string): Lead | null {
    const lead = (readJson(this.f("leads-dismissed", id)) as Partial<DismissedLead> | null)?.lead;
    if (!lead || !isRecallId(lead.id)) return null;
    this.addLead(lead);
    rmSync(this.f("leads-dismissed", id), { force: true });
    return lead;
  }
  lessons(): Lesson[] {
    return listJson<Lesson>(this.p("lessons")).sort((a, b) => b.started_at.localeCompare(a.started_at));
  }
  startLesson(id: string, conversation: { agentId: string; conversationId: string }, now = Date.now()): Lesson | null {
    const lead = this.lead(id);
    if (!lead) return null;
    const lesson: Lesson = { lead, agent_id: conversation.agentId, conversation_id: conversation.conversationId, started_at: new Date(now).toISOString() };
    writeJson(this.f("lessons", id), lesson);
    rmSync(this.f("leads", id), { force: true });
    return lesson;
  }

  exists(): boolean {
    return existsSync(this.dir);
  }
}
