import { lokiDir } from "./paths.ts";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The models you have used lately, for the model picker's quick picks (app/src/chat/ModelPicker.tsx modelLists), most
 * recent first: a model picked in loki, or the model of a chat you send a message in, moves to the front. Kept here,
 * so the Mac and the phone share them.
 */

/** How many recent models the quick picks lead with. */
export const RECENT_MODELS_MAX = 5;

export const recentModelsFile = (): string => process.env.LOKI_RECENT_MODELS_FILE ?? join(lokiDir(), "state", "recent-models.json");

const handles = (value: unknown): string[] => (Array.isArray(value) ? value.filter((h): h is string => typeof h === "string" && h.length > 0) : []);

function readJson(file: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readRecentModels(file = recentModelsFile()): string[] {
  return handles(readJson(file).recent).slice(0, RECENT_MODELS_MAX);
}

/** A model picked in loki goes to the front of the list (written atomically); returns the list. */
export function addRecentModel(handle: string, file = recentModelsFile()): string[] {
  const mine = [handle, ...handles(readJson(file).recent).filter((h) => h !== handle)].slice(0, RECENT_MODELS_MAX);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, recent: mine }, null, 2) + "\n");
  renameSync(tmp, file);
  return mine;
}
