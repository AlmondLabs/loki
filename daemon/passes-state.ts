import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * What the background passes keep between runs (plan 018, KTD8): their settings, and each job's cursor in each chat
 * plus Learn's count of cards written today. Both files are the daemon's alone; nothing else writes them. The first
 * start after the passes came carries over what reflection and Learn kept before (`migrate`), and the old files are
 * left as they were.
 */

export type JobName = "reflection" | "learn";
export const JOBS: readonly JobName[] = ["reflection", "learn"];

export type PassSettings = { reflection: { enabled: boolean }; learn: { enabled: boolean; dailyCap: number } };

/** Learn's cards a day unless the person says otherwise: a ceiling, not a target (plan 018, R13). */
export const DEFAULT_DAILY_CAP = 5;
/** Learn's cap before the passes, which carries over as the new default rather than as a choice (KTD9). */
const OLD_DEFAULT_DAILY_CAP = 25;

export const DEFAULT_SETTINGS: PassSettings = { reflection: { enabled: true }, learn: { enabled: false, dailyCap: DEFAULT_DAILY_CAP } };

type Cursors = { cursors: Record<JobName, Record<string, number>>; learnWritten: { day: string; count: number }; learnLast?: { at: string; note: string } };

const key = (agentId: string, chatId: string) => `${agentId}/${chatId}`;

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${file}.tmp`, file);
}

export function normalSettings(s: Partial<{ reflection: Partial<PassSettings["reflection"]>; learn: Partial<PassSettings["learn"]> }> | null): PassSettings {
  const cap = s?.learn?.dailyCap;
  return {
    reflection: { enabled: s?.reflection?.enabled ?? DEFAULT_SETTINGS.reflection.enabled },
    learn: { enabled: s?.learn?.enabled ?? DEFAULT_SETTINGS.learn.enabled, dailyCap: typeof cap === "number" && Number.isFinite(cap) && cap >= 0 ? Math.round(cap) : DEFAULT_DAILY_CAP },
  };
}

export class PassState {
  readonly settingsFile: string;
  readonly cursorsFile: string;
  private data: Cursors;

  constructor(stateDir: string) {
    this.settingsFile = join(stateDir, "passes.json");
    this.cursorsFile = join(stateDir, "pass-cursors.json");
    const read = readJson<Partial<Cursors>>(this.cursorsFile);
    this.data = { cursors: { reflection: { ...read?.cursors?.reflection }, learn: { ...read?.cursors?.learn } }, learnWritten: read?.learnWritten ?? { day: "", count: 0 }, ...(read?.learnLast ? { learnLast: read.learnLast } : {}) };
  }

  /** Whether the passes have started here before: no settings file means this is the first start. */
  started(): boolean {
    return existsSync(this.settingsFile);
  }

  settings(): PassSettings {
    return normalSettings(readJson(this.settingsFile));
  }

  setSettings(s: Parameters<typeof normalSettings>[0]): PassSettings {
    const now = this.settings();
    writeJson(this.settingsFile, normalSettings({ reflection: { ...now.reflection, ...s?.reflection }, learn: { ...now.learn, ...s?.learn } }));
    return this.settings();
  }

  cursor(job: JobName, agentId: string, chatId: string): number | undefined {
    return this.data.cursors[job][key(agentId, chatId)];
  }

  setCursor(job: JobName, agentId: string, chatId: string, at: number): void {
    this.data.cursors[job][key(agentId, chatId)] = at;
    this.save();
  }

  /** Cards Learn has written on `day` (an ISO date). */
  writtenOn(day: string): number {
    return this.data.learnWritten.day === day ? this.data.learnWritten.count : 0;
  }

  noteWritten(day: string, count: number): void {
    this.data.learnWritten = { day, count: this.writtenOn(day) + count };
    this.save();
  }

  /** Learn's last run and a line on what it did, for the Learn section's status. */
  learnLast(): { at: string; note: string } | null {
    return this.data.learnLast ?? null;
  }

  noteLearnRun(at: string, note: string): void {
    this.data.learnLast = { at, note };
    this.save();
  }

  private save(): void {
    writeJson(this.cursorsFile, this.data);
  }

  /**
   * The first start: settings and cursors from what reflection and Learn kept before, and every chat with no cursor
   * for a job starts from where it is now (KTD7), so the first sweeps do not read every old chat at once.
   */
  migrate(old: { reflectionSettings: string; reflectionRoot: string; learnWorker: string }, chats: ReadonlyArray<{ agentId: string; chatId: string; entries: number }>): void {
    const reflection = readJson<{ trigger?: string }>(old.reflectionSettings);
    const worker = readJson<{ enabled?: boolean; dailyCap?: number; cursors?: Record<string, number>; written?: { day?: string; count?: number } }>(old.learnWorker);
    for (const [k, at] of Object.entries(worker?.cursors ?? {})) if (typeof at === "number") this.data.cursors.learn[k] = at;
    if (worker?.written?.day) this.data.learnWritten = { day: worker.written.day, count: worker.written.count ?? 0 };
    for (const agentId of dirs(old.reflectionRoot)) {
      for (const chatId of dirs(join(old.reflectionRoot, agentId))) {
        const at = readJson<{ reflected_through?: number }>(join(old.reflectionRoot, agentId, chatId, "state.json"))?.reflected_through;
        if (typeof at === "number") this.data.cursors.reflection[key(agentId, chatId)] = at;
      }
    }
    for (const c of chats) for (const job of JOBS) this.data.cursors[job][key(c.agentId, c.chatId)] ??= c.entries;
    this.save();
    const cap = worker?.dailyCap;
    writeJson(this.settingsFile, normalSettings({ reflection: { enabled: reflection?.trigger !== "off" }, learn: { enabled: worker?.enabled === true, dailyCap: cap === undefined || cap === OLD_DEFAULT_DAILY_CAP ? DEFAULT_DAILY_CAP : cap } }));
  }
}

function dirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}
