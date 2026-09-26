import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The models you have used lately, for the model picker's quick picks (app/src/chat/ModelPicker.tsx modelLists):
 * the ones picked in loki, newest first (kept here, so the Mac and the phone share them), then Letta Code's own
 * recent models (`recentModels` in ~/.letta/settings.json, which its terminal picker keeps). Letta's file is only
 * read: a model picked in loki goes through the app-server, which does not add to it.
 */

/** How many recent models the quick picks lead with; Letta keeps five of its own. */
export const RECENT_MODELS_MAX = 5;

export const recentModelsFile = (): string => process.env.LOKI_RECENT_MODELS_FILE ?? join(homedir(), ".letta", "loki", "state", "recent-models.json");
export const lettaSettingsFile = (): string => process.env.LOKI_LETTA_SETTINGS_FILE ?? join(homedir(), ".letta", "settings.json");

const handles = (value: unknown): string[] => (Array.isArray(value) ? value.filter((h): h is string => typeof h === "string" && h.length > 0) : []);

function readJson(file: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** loki's picks first, then Letta's, each once, at most RECENT_MODELS_MAX. */
export function mergeRecent(loki: string[], letta: string[]): string[] {
  return [...new Set([...loki, ...letta])].slice(0, RECENT_MODELS_MAX);
}

export function readRecentModels(file = recentModelsFile(), settings = lettaSettingsFile()): string[] {
  return mergeRecent(handles(readJson(file).recent), handles(readJson(settings).recentModels));
}

/** A model picked in loki goes to the front of loki's list (written atomically); returns the merged list. */
export function addRecentModel(handle: string, file = recentModelsFile(), settings = lettaSettingsFile()): string[] {
  const mine = [handle, ...handles(readJson(file).recent).filter((h) => h !== handle)].slice(0, RECENT_MODELS_MAX);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, recent: mine }, null, 2) + "\n");
  renameSync(tmp, file);
  return readRecentModels(file, settings);
}
