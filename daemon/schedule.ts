import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, type Extension, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AgentInfoDoc, ChatDoc } from "./kernel/index.ts";
import type { Delivery } from "./engine.ts";
import { withKind } from "./tool-kinds.ts";

/**
 * Scheduled tasks (plan 017, U11): a prompt the agent sets to arrive in a chat on a cron schedule, in a timezone, once
 * or again and again. They are kept in one file in Letta's record shape (so the import carries Letta's over, U14) and
 * checked once a minute; a slot missed while loki was closed fires once at the next start, never once per slot. A
 * fired prompt begins "Scheduled task", which is how the Inbox tells a schedule's turn from yours
 * (core/attention/priority.ts).
 */

/** One scheduled task, in Letta's record shape (snake_case, as the file keeps it). A one-time task is `done` once it fires; `cancelled` is a deleted one, kept in the file. */
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

/** One cron field ("*", "5", "1-5", "*\/15", "1,3"), as the values it allows. */
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

/** A five-field cron expression: minute hour day-of-month month day-of-week. */
export function parseCron(expr: string): Fields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`a cron expression has five fields: ${expr}`);
  const weekday = field(parts[4], 0, 7);
  if (weekday.has(7)) weekday.add(0); // Sunday is 0 or 7
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

/** The wall-clock parts of `at` in a timezone. */
function partsIn(at: Date, timezone: string) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { minute: Number(p.minute), hour: Number(p.hour), day: Number(p.day), month: Number(p.month), weekday };
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

/** Whether a slot came due after `from` and up to `to` (minutes; at most the last 31 days are looked at). */
export function dueBetween(fields: Fields, timezone: string, from: Date, to: Date): boolean {
  const start = Math.max(Math.floor(from.getTime() / 60_000) + 1, Math.floor(to.getTime() / 60_000) - 31 * 24 * 60);
  for (let m = start; m <= Math.floor(to.getTime() / 60_000); m++) if (matches(fields, new Date(m * 60_000), timezone)) return true;
  return false;
}

/**
 * How a schedule's prompt reaches its chat: in the daemon, as a message from loki that waits for a running turn to end
 * (DaemonChats.deliver). It resolves once the prompt is handed over, with how the turn ends where the engine can tell.
 */
export type Fire = (agentId: string, conversationId: string, text: string) => Promise<Delivery | null>;

/**
 * After a firing could not reach the model (no network, a provider down), how many minutes until each try again
 * (plan 037): three tries, the last an hour on, which covers a Mac waking from sleep. Any other end is not tried again.
 */
export const RETRY_AFTER_MINUTES = [5, 15, 60];

/** A task's prompt as it arrives; a retry says it is one, with when the first try was, in the task's timezone. */
function promptOf(task: ScheduledTask, retry: boolean): string {
  const text = `Scheduled task "${task.name}": ${task.prompt}`;
  if (!retry || !task.last_fired_at) return text;
  const first = new Intl.DateTimeFormat("en-GB", { timeZone: task.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(task.last_fired_at));
  return `${text}\n\n(another try: at ${first} the model could not be reached)`;
}

/** The scheduled tasks in their file: `start` checks them once a minute and fires what came due, and the tools add, list and cancel them. */
export class Schedules {
  private readonly file: string;
  private readonly fire: Fire;
  private readonly report: (message: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  private readonly now: () => Date;

  constructor(file: string, fire: Fire, report: (message: string) => void = () => {}, now: () => Date = () => new Date()) {
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
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, tasks }, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }

  create(t: Omit<ScheduledTask, "id" | "status" | "created_at" | "last_fired_at" | "fire_count">, now = new Date()): ScheduledTask {
    parseCron(t.cron);
    partsIn(now, t.timezone); // a timezone Intl does not know throws here
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

  /**
   * A task as it was on another Mac, its id and when it last fired kept, so a slot it already fired there does not
   * fire again here (plan 023, U9). One already here is left as it is.
   */
  adopt(task: ScheduledTask): void {
    const tasks = this.list();
    if (tasks.some((t) => t.id === task.id)) return;
    this.save([...tasks, task]);
  }

  /** Cancel a task of this agent by its id or name; false when there is none. */
  cancel(agentId: string, idOrName: string): boolean {
    const tasks = this.list();
    const task = tasks.find((t) => t.agent_id === agentId && t.status === "active" && (t.id === idOrName || t.name === idOrName));
    if (!task) return false;
    task.status = "cancelled";
    this.save(tasks);
    return true;
  }

  /**
   * Fire every active task with a slot due since it last fired (or was made), once each. A firing is written down before
   * its prompt goes out, against the list as it is then, so a task made or cancelled while another fires is kept. A tick
   * that starts while one is still firing (a slow chat) does nothing.
   */
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
            due = dueBetween(parseCron(task.cron), task.timezone, new Date(task.last_fired_at ?? task.created_at), now);
          } catch (error) {
            this.report(`schedule ${task.name}: ${String(error)}`);
            continue;
          }
        // A slot that comes due replaces a retry still waiting: one task never has two runs open.
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
        // How the turn ends comes later; the tick does not wait for it, so one slow turn holds no other task back.
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

  /**
   * A firing's turn ended (plan 037). One that could not reach the model is tried again after the next of
   * RETRY_AFTER_MINUTES, while tries are left and the task has not fired anew since; anything else ends its tries.
   */
  settled(id: string, outcome: Awaited<Delivery["outcome"]>, firing: { fireCount: number; retries: number }): void {
    const tasks = this.list();
    const task = tasks.find((t) => t.id === id);
    if (!task || task.status === "cancelled") return;
    // The task fired again (a slot, or a retry) before this turn ended: that firing's own end decides.
    if (task.fire_count !== firing.fireCount || (task.retries ?? 0) !== firing.retries) return;
    const tries = task.retries ?? 0;
    const wait = outcome.status === "unanswered" && outcome.reason === "model_error" ? RETRY_AFTER_MINUTES[tries] : undefined;
    task.retry_at = wait === undefined ? null : new Date(this.now().getTime() + wait * 60_000).toISOString();
    if (wait === undefined) task.retries = 0;
    else this.report(`schedule ${task.name}: the model could not be reached; trying again in ${wait} minutes`);
    this.save(tasks);
  }

  /** Check at start (a slot missed while closed) and then once a minute. */
  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

/** The scheduling tools (`schedule_create`, `schedule_list`, `schedule_delete`), as an extension over `schedules`; each acts for the chat and agent it is called from. */
export function scheduleExtension(schedules: Schedules): Extension {
  const caller = async (api: ToolExecutionApi, context: Context) => {
    const [agent, chat] = await Promise.all([api.snapshot(AgentInfoDoc, context), api.snapshot(ChatDoc, api.conversationId, context)]);
    return { agentId: agent?.id ?? "", chatId: chat?.id ?? "" };
  };
  const text = (t: string) => ({ output: [{ type: "text" as const, text: t }] });
  return defineExtension({
    name: "loki.schedule",
    tools: [
      withKind(
        "command",
        defineTool({
          name: "schedule_create",
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
          } as never,
          execute: async (args, api, context) => {
            const a = args as { name: string; cron: string; prompt: string; timezone?: string; recurring?: boolean; description?: string };
            const { agentId, chatId } = await caller(api, context);
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
        }),
      ),
      withKind(
        "read",
        defineTool({
          name: "schedule_list",
          description: "Your scheduled tasks that are still active.",
          parameters: { type: "object", properties: {} } as never,
          execute: async (_args, api, context) => {
            const { agentId } = await caller(api, context);
            const mine = schedules.list().filter((t) => t.agent_id === agentId && t.status === "active");
            return text(
              mine.length
                ? mine.map((t) => `- ${t.name} (${t.id}): ${t.cron} ${t.timezone}${t.recurring ? "" : ", once"}; fired ${t.fire_count}×`).join("\n")
                : "no scheduled tasks",
            );
          },
        }),
      ),
      withKind(
        "command",
        defineTool({
          name: "schedule_delete",
          description: "Cancel one of your scheduled tasks by its name or id.",
          parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } as never,
          execute: async (args, api, context) => {
            const { agentId } = await caller(api, context);
            return text(schedules.cancel(agentId, (args as { name: string }).name) ? "cancelled" : "no such scheduled task");
          },
        }),
      ),
    ],
  });
}
