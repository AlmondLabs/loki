import type { Context } from "@earendil-works/chord";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { AgentInfoDoc, ChatDoc } from "./kernel/index.ts";
import type { Delivery } from "./engine.ts";
import { piTool, type ChatCall, type ChatTool } from "./chat-tools.ts";
import { writeJsonAtomic } from "../mod/json-file.ts";
import type { Report } from "./report.ts";

/** One scheduled task, as the file keeps it (snake_case). A one-time task is `done` once it fires; `cancelled` is a deleted one, kept in the file. */
export interface ScheduledTask {
  id: string;
  agent_id: string;
  conversation_id: string;
  name: string;
  description: string | null;
  cron: string;
  timezone: string;
  recurring: boolean;
  prompt: string;
  status: "active" | "done" | "cancelled";
  created_at: string;
  last_fired_at: string | null;
  fire_count: number;
  /** When its last firing could not reach the model, when it tries again (plan 037); absent otherwise. */
  retry_at?: string | null;
  /** How many tries that firing has had after the first, at most RETRY_AFTER_MINUTES.length. */
  retries?: number;
}

interface Fields {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
  dayStar: boolean;
  weekdayStar: boolean;
}

function field(text: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    const [lo, hi] = range === "*" ? [min, max] : range.includes("-") ? range.split("-").map(Number) : [Number(range), stepText ? max : Number(range)];
    if (![lo, hi, step].every(Number.isInteger) || step < 1 || lo < min || hi > max || lo > hi) throw new Error(`not a cron field: ${text}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

const SUNDAY = 0;
const SUNDAY_AS_SEVEN = 7;

export function parseCron(expr: string): Fields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`a cron expression has five fields: ${expr}`);
  const weekday = field(parts[4], 0, 7);
  if (weekday.has(SUNDAY_AS_SEVEN)) weekday.add(SUNDAY);
  return {
    minute: field(parts[0], 0, 59),
    hour: field(parts[1], 0, 23),
    day: field(parts[2], 1, 31),
    month: field(parts[3], 1, 12),
    weekday,
    dayStar: parts[2] === "*",
    weekdayStar: parts[4] === "*",
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsIn(at: Date, timezone: string) {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatters.set(timezone, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { minute: Number(p.minute), hour: Number(p.hour), day: Number(p.day), month: Number(p.month), year: Number(p.year), weekday };
}

function checkTimezone(timezone: string, at: Date): void {
  partsIn(at, timezone);
}

/** Whether a minute matches; day-of-month and day-of-week match either, as cron has it when both are given. */
export function matches(fields: Fields, at: Date, timezone: string): boolean {
  const p = partsIn(at, timezone);
  if (!fields.minute.has(p.minute) || !fields.hour.has(p.hour) || !fields.month.has(p.month)) return false;
  const day = fields.day.has(p.day);
  const weekday = fields.weekday.has(p.weekday);
  if (fields.dayStar && fields.weekdayStar) return true;
  if (fields.dayStar) return weekday;
  if (fields.weekdayStar) return day;
  return day || weekday;
}

/**
 * Whether a slot came due after `from` and up to `to` (minutes; at most the last 31 days are looked at). `fired`, the
 * last firing, is not due again: when the clocks go back an hour, its wall-clock minute comes round a second time.
 */
export function dueBetween(fields: Fields, timezone: string, from: Date, to: Date, fired?: Date): boolean {
  const start = Math.max(Math.floor(from.getTime() / 60_000) + 1, Math.floor(to.getTime() / 60_000) - 31 * 24 * 60);
  const last = fired ? partsIn(fired, timezone) : null;
  for (let m = start; m <= Math.floor(to.getTime() / 60_000); m++) {
    const at = new Date(m * 60_000);
    if (!matches(fields, at, timezone)) continue;
    if (!last) return true;
    const p = partsIn(at, timezone);
    if (p.minute === last.minute && p.hour === last.hour && p.day === last.day && p.month === last.month && p.year === last.year) continue;
    return true;
  }
  return false;
}

export type Fire = (agentId: string, conversationId: string, text: string) => Promise<Delivery | null>;

export const RETRY_AFTER_MINUTES = [5, 15, 60];

function promptOf(task: ScheduledTask, retry: boolean): string {
  const text = `Scheduled task "${task.name}": ${task.prompt}`;
  if (!retry || !task.last_fired_at) return text;
  const first = new Intl.DateTimeFormat("en-GB", { timeZone: task.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(task.last_fired_at));
  return `${text}\n\n(another try: at ${first} the model could not be reached)`;
}

export class Schedules {
  private readonly file: string;
  private readonly fire: Fire;
  private readonly report: Report;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private readonly quiet = new Map<string, { from: number; to: number }>();

  private readonly now: () => Date;

  constructor(file: string, fire: Fire, report: Report = () => {}, now: () => Date = () => new Date()) {
    this.file = file;
    this.fire = fire;
    this.report = report;
    this.now = now;
  }

  list(): ScheduledTask[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { tasks?: ScheduledTask[] };
      return Array.isArray(raw.tasks) ? raw.tasks : [];
    } catch {
      return [];
    }
  }

  private save(tasks: ScheduledTask[]): void {
    writeJsonAtomic(this.file, { version: 1, tasks }, { pretty: true });
  }

  create(t: Omit<ScheduledTask, "id" | "status" | "created_at" | "last_fired_at" | "fire_count">, now = new Date()): ScheduledTask {
    parseCron(t.cron);
    checkTimezone(t.timezone, now);
    const task: ScheduledTask = {
      ...t,
      id: randomBytes(4).toString("hex"),
      status: "active",
      created_at: now.toISOString(),
      last_fired_at: null,
      fire_count: 0,
    };
    this.save([...this.list(), task]);
    return task;
  }

  adopt(task: ScheduledTask): void {
    const tasks = this.list();
    const here = tasks.find((t) => t.id === task.id);
    if (here && here.status !== "cancelled") return;
    this.save([...tasks.filter((t) => t !== here), task]);
  }

  cancel(agentId: string, idOrName: string): boolean {
    const tasks = this.list();
    const task = tasks.find((t) => t.agent_id === agentId && t.status === "active" && (t.id === idOrName || t.name === idOrName));
    if (!task) return false;
    task.status = "cancelled";
    this.save(tasks);
    return true;
  }

  cancelAgent(agentId: string): number {
    const tasks = this.list();
    const mine = tasks.filter((t) => t.agent_id === agentId && t.status === "active");
    if (mine.length === 0) return 0;
    for (const t of mine) t.status = "cancelled";
    this.save(tasks);
    return mine.length;
  }

  async tick(now = this.now()): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      let fired = 0;
      for (const { id } of this.list()) {
        const tasks = this.list();
        const task = tasks.find((t) => t.id === id);
        if (!task || task.status === "cancelled") continue;
        let due = false;
        if (task.status === "active")
          try {
            const from = Date.parse(task.last_fired_at ?? task.created_at);
            const key = `${task.id}\u0000${task.cron}\u0000${task.timezone}`;
            const seen = this.quiet.get(key);
            const known = seen !== undefined && seen.from <= from && from <= seen.to;
            const fired = task.last_fired_at ? new Date(task.last_fired_at) : undefined;
            due = dueBetween(parseCron(task.cron), task.timezone, new Date(known ? seen.to : from), now, fired);
            if (!due) this.quiet.set(key, { from: known ? seen.from : from, to: now.getTime() });
          } catch (error) {
            this.report(`schedule ${task.name}: ${String(error)}`);
            continue;
          }
        const retry = !due && !!task.retry_at && Date.parse(task.retry_at) <= now.getTime();
        if (!due && !retry) continue;
        if (due) {
          task.last_fired_at = now.toISOString();
          task.fire_count += 1;
          task.retries = 0;
          if (!task.recurring) task.status = "done";
        } else task.retries = (task.retries ?? 0) + 1;
        task.retry_at = null;
        this.save(tasks);
        fired++;
        const delivery = await this.fire(task.agent_id, task.conversation_id, promptOf(task, retry)).catch((error: unknown) => {
          this.report(`schedule ${task.name} did not fire: ${String(error)}`);
          return null;
        });
        const firing = { fireCount: task.fire_count, retries: task.retries ?? 0 };
        if (delivery)
          void delivery.outcome.then(
            (outcome) => this.settled(task.id, outcome, firing),
            (error: unknown) => this.report(`schedule ${task.name}: ${String(error)}`),
          );
      }
      return fired;
    } finally {
      this.ticking = false;
    }
  }

  settled(id: string, outcome: Awaited<Delivery["outcome"]>, firing: { fireCount: number; retries: number }): void {
    const tasks = this.list();
    const task = tasks.find((t) => t.id === id);
    if (!task || task.status === "cancelled") return;
    if (task.fire_count !== firing.fireCount || (task.retries ?? 0) !== firing.retries) return;
    const tries = task.retries ?? 0;
    const wait = outcome.status === "unanswered" && outcome.reason === "model_error" ? RETRY_AFTER_MINUTES[tries] : undefined;
    task.retry_at = wait === undefined ? null : new Date(this.now().getTime() + wait * 60_000).toISOString();
    if (wait === undefined) task.retries = 0;
    else this.report(`schedule ${task.name}: the model could not be reached; trying again in ${wait} minutes`, "warning");
    this.save(tasks);
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

const SCRIPTS_ONLY = ["tools"] as const;

export function scheduleTools(schedules: Schedules): ChatTool[] {
  const caller = async (call: ChatCall, context: Context) => {
    const [agent, chat] = await Promise.all([call.read.snapshot(AgentInfoDoc, context), call.read.snapshot(ChatDoc, call.conversationId, context)]);
    return { agentId: agent?.id ?? "", chatId: chat?.id ?? "" };
  };
  const text = (t: string) => ({ output: [{ type: "text" as const, text: t }] });
  return [
    {
      kind: "command",
      name: "schedule_create",
      callers: SCRIPTS_ONLY,
      description:
        "Schedule a prompt to arrive in this chat on a cron schedule (minute hour day month weekday), in a timezone such as Asia/Kolkata; once (recurring false) or every time it comes due.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          cron: { type: "string" },
          prompt: { type: "string" },
          timezone: { type: "string" },
          recurring: { type: "boolean" },
          description: { type: "string" },
        },
        required: ["name", "cron", "prompt"],
      },
      run: async (args, call, context) => {
        const a = args as { name: string; cron: string; prompt: string; timezone?: string; recurring?: boolean; description?: string };
        const { agentId, chatId } = await caller(call, context);
        const task = schedules.create({
          agent_id: agentId,
          conversation_id: chatId,
          name: a.name,
          description: a.description ?? null,
          cron: a.cron,
          timezone: a.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
          recurring: a.recurring !== false,
          prompt: a.prompt,
        });
        return text(`scheduled "${task.name}" (${task.cron}, ${task.timezone}${task.recurring ? "" : ", once"})`);
      },
    },
    {
      kind: "read",
      name: "schedule_list",
      callers: SCRIPTS_ONLY,
      description: "Your scheduled tasks that are still active.",
      parameters: { type: "object", properties: {} },
      run: async (_args, call, context) => {
        const { agentId } = await caller(call, context);
        const mine = schedules.list().filter((t) => t.agent_id === agentId && t.status === "active");
        return text(
          mine.length
            ? mine.map((t) => `- ${t.name} (${t.id}): ${t.cron} ${t.timezone}${t.recurring ? "" : ", once"}; fired ${t.fire_count}×`).join("\n")
            : "no scheduled tasks",
        );
      },
    },
    {
      kind: "command",
      name: "schedule_delete",
      callers: SCRIPTS_ONLY,
      description: "Cancel one of your scheduled tasks by its name or id.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      run: async (args, call, context) => {
        const { agentId } = await caller(call, context);
        return text(schedules.cancel(agentId, (args as { name: string }).name) ? "cancelled" : "no such scheduled task");
      },
    },
  ];
}

export function scheduleExtension(schedules: Schedules): Extension {
  return defineExtension({ name: "loki.schedule", tools: scheduleTools(schedules).map(piTool) });
}
