import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PassSettings } from "../core/attention/protocol.ts";
import { readJson, writeJsonAtomic } from "../mod/json-file.ts";

export type { PassSettings };

export type JobName = "reflection" | "learn";
export const JOBS: readonly JobName[] = ["reflection", "learn"];

export const DEFAULT_DAILY_CAP = 5;

export const DEFAULT_SETTINGS: PassSettings = {
  reflection: { enabled: true },
  learn: { enabled: false, daily_cap: DEFAULT_DAILY_CAP },
  acp: { enabled: true },
};

interface Cursors {
  cursors: Record<JobName, Record<string, number>>;
  learn_written: { day: string; count: number };
  learn_last?: { at: string; note: string };
}

const key = (agentId: string, chatId: string) => `${agentId}/${chatId}`;

const writeJson = (file: string, value: unknown) => writeJsonAtomic(file, value, { pretty: true });

export function normalSettings(
  s: Partial<{ reflection: Partial<PassSettings["reflection"]>; learn: Partial<PassSettings["learn"]>; acp: Partial<PassSettings["acp"]> }> | null,
): PassSettings {
  const cap = s?.learn?.daily_cap;
  return {
    reflection: { enabled: s?.reflection?.enabled ?? DEFAULT_SETTINGS.reflection.enabled },
    learn: {
      enabled: s?.learn?.enabled ?? DEFAULT_SETTINGS.learn.enabled,
      daily_cap: typeof cap === "number" && Number.isFinite(cap) && cap >= 0 ? Math.round(cap) : DEFAULT_DAILY_CAP,
    },
    acp: { enabled: s?.acp?.enabled ?? DEFAULT_SETTINGS.acp.enabled },
  };
}

export class PassState {
  readonly settingsFile: string;
  readonly cursorsFile: string;
  private data: Cursors;

  constructor(stateDir: string) {
    this.settingsFile = join(stateDir, "passes.json");
    this.cursorsFile = join(stateDir, "pass-cursors.json");
    const read = readJson(this.cursorsFile) as Partial<Cursors> | null;
    this.data = {
      cursors: { reflection: { ...read?.cursors?.reflection }, learn: { ...read?.cursors?.learn } },
      learn_written: read?.learn_written ?? { day: "", count: 0 },
      ...(read?.learn_last ? { learn_last: read.learn_last } : {}),
    };
  }

  started(): boolean {
    return existsSync(this.cursorsFile);
  }

  settings(): PassSettings {
    return normalSettings(readJson(this.settingsFile) as Parameters<typeof normalSettings>[0]);
  }

  setSettings(s: Parameters<typeof normalSettings>[0]): PassSettings {
    const now = this.settings();
    writeJson(
      this.settingsFile,
      normalSettings({ reflection: { ...now.reflection, ...s?.reflection }, learn: { ...now.learn, ...s?.learn }, acp: { ...now.acp, ...s?.acp } }),
    );
    return this.settings();
  }

  cursor(job: JobName, agentId: string, chatId: string): number | undefined {
    return this.data.cursors[job][key(agentId, chatId)];
  }

  setCursor(job: JobName, agentId: string, chatId: string, at: number): void {
    this.data.cursors[job][key(agentId, chatId)] = at;
    this.save();
  }

  writtenOn(day: string): number {
    return this.data.learn_written.day === day ? this.data.learn_written.count : 0;
  }

  noteWritten(day: string, count: number): void {
    this.data.learn_written = { day, count: this.writtenOn(day) + count };
    this.save();
  }

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

  startCursors(chats: ReadonlyArray<{ agentId: string; chatId: string; entries: number }>): void {
    for (const c of chats) for (const job of JOBS) this.data.cursors[job][key(c.agentId, c.chatId)] ??= c.entries;
    this.save();
  }
}
