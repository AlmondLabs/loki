import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PassSettings } from "../core/attention/protocol.ts";
import { migrateKeys } from "../core/snake-keys.ts";

export type { PassSettings };

/**
 * What the background passes keep between runs (plan 018, KTD8): their settings, and each job's cursor in each chat
 * plus Learn's count of cards written today. Both files are the daemon's alone; nothing else writes them. The first
 * start after the passes came carries over what reflection and Learn kept before (`migrate`), and the old files are
 * left as they were.
 */

/** A background pass's job, as its settings and cursors are keyed. */
export type JobName = "reflection" | "learn";
/** Every job, in the order the runner goes through them. */
export const JOBS: readonly JobName[] = ["reflection", "learn"];

/** Learn's cards a day unless the person says otherwise: a ceiling, not a target (plan 018, R13). */
export const DEFAULT_DAILY_CAP = 5;
/** Learn's cap before the passes, which carries over as the new default rather than as a choice (KTD9). */
const OLD_DEFAULT_DAILY_CAP = 25;

/** The settings before the person changes any: reflection on, Learn off. */
export const DEFAULT_SETTINGS: PassSettings = { reflection: { enabled: true }, learn: { enabled: false, daily_cap: DEFAULT_DAILY_CAP } };

interface Cursors {
  cursors: Record<JobName, Record<string, number>>;
  learn_written: { day: string; count: number };
  learn_last?: { at: string; note: string };
}

const key = (agentId: string, chatId: string) => `${agentId}/${chatId}`;

/** A JSON file's contents, or null when it is missing or not JSON; the caller says what it holds. */
function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${file}.tmp`, file);
}

/** Settings as read or sent, made whole: a missing field takes its default, and a cap that is not a non-negative number is DEFAULT_DAILY_CAP. */
export function normalSettings(s: Partial<{ reflection: Partial<PassSettings["reflection"]>; learn: Partial<PassSettings["learn"]> }> | null): PassSettings {
  const cap = s?.learn?.daily_cap;
  return {
    reflection: { enabled: s?.reflection?.enabled ?? DEFAULT_SETTINGS.reflection.enabled },
    learn: {
      enabled: s?.learn?.enabled ?? DEFAULT_SETTINGS.learn.enabled,
      daily_cap: typeof cap === "number" && Number.isFinite(cap) && cap >= 0 ? Math.round(cap) : DEFAULT_DAILY_CAP,
    },
  };
}

/** The passes' state in `<stateDir>`: the settings in `passes.json`, and the cursors, Learn's daily count and its last run in `pass-cursors.json`. */
export class PassState {
  readonly settingsFile: string;
  readonly cursorsFile: string;
  private data: Cursors;

  constructor(stateDir: string) {
    this.settingsFile = join(stateDir, "passes.json");
    this.cursorsFile = join(stateDir, "pass-cursors.json");
    const { value: read, changed } = migrateKeys(readJson(this.cursorsFile) as Partial<Cursors> | null);
    this.data = {
      cursors: { reflection: { ...read?.cursors?.reflection }, learn: { ...read?.cursors?.learn } },
      learn_written: read?.learn_written ?? { day: "", count: 0 },
      ...(read?.learn_last ? { learn_last: read.learn_last } : {}),
    };
    // Saved camelCase before October 2026: written back once in the new shape.
    if (changed) this.save();
  }

  /**
   * Whether the passes have started here before. The cursors file marks it: only the carry-over and the runner write
   * it, while a settings change in the first seconds after a start could write the settings file before either.
   */
  started(): boolean {
    return existsSync(this.cursorsFile);
  }

  settings(): PassSettings {
    const { value, changed } = migrateKeys(readJson(this.settingsFile) as Parameters<typeof normalSettings>[0]);
    const settings = normalSettings(value);
    // Saved camelCase (`dailyCap`) before October 2026: written back once in the new shape.
    if (changed) writeJson(this.settingsFile, settings);
    return settings;
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
    return this.data.learn_written.day === day ? this.data.learn_written.count : 0;
  }

  noteWritten(day: string, count: number): void {
    this.data.learn_written = { day, count: this.writtenOn(day) + count };
    this.save();
  }

  /** Learn's last run and a line on what it did, for the Learn section's status. */
  learnLast(): { at: string; note: string } | null {
    return this.data.learn_last ?? null;
  }

  noteLearnRun(at: string, note: string): void {
    this.data.learn_last = { at, note };
    this.save();
  }

  private save(): void {
    writeJson(this.cursorsFile, this.data);
  }

  /**
   * The first start: settings and cursors from what reflection and Learn kept before, and every chat with no cursor
   * for a job starts from where it is now (KTD7), so the first sweeps do not read every old chat at once.
   */
  migrate(
    old: { reflectionSettings: string; reflectionRoot: string; learnWorker: string },
    chats: ReadonlyArray<{ agentId: string; chatId: string; entries: number }>,
  ): void {
    const reflection = readJson(old.reflectionSettings) as { trigger?: string } | null;
    const worker = readJson(old.learnWorker) as {
      enabled?: boolean;
      dailyCap?: number;
      cursors?: Record<string, number>;
      written?: { day?: string; count?: number };
    } | null;
    for (const [k, at] of Object.entries(worker?.cursors ?? {})) if (typeof at === "number") this.data.cursors.learn[k] = at;
    if (worker?.written?.day) this.data.learn_written = { day: worker.written.day, count: worker.written.count ?? 0 };
    for (const agentId of dirs(old.reflectionRoot)) {
      for (const chatId of dirs(join(old.reflectionRoot, agentId))) {
        const at = (readJson(join(old.reflectionRoot, agentId, chatId, "state.json")) as { reflected_through?: number } | null)?.reflected_through;
        if (typeof at === "number") this.data.cursors.reflection[key(agentId, chatId)] = at;
      }
    }
    for (const c of chats) for (const job of JOBS) this.data.cursors[job][key(c.agentId, c.chatId)] ??= c.entries;
    this.save();
    const cap = worker?.dailyCap;
    writeJson(
      this.settingsFile,
      normalSettings({
        reflection: { enabled: reflection?.trigger !== "off" },
        learn: { enabled: worker?.enabled === true, daily_cap: cap === undefined || cap === OLD_DEFAULT_DAILY_CAP ? DEFAULT_DAILY_CAP : cap },
      }),
    );
  }
}

function dirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}
