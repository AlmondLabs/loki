import { lokiDir } from "./paths.ts";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./json-file.ts";

/**
 * The models you have used lately, for the model picker's quick picks (app/src/chat/model-picker.tsx modelLists), most
 * recent first: a model picked in loki, or the model of a chat you send a message in, moves to the front. Kept here,
 * so the Mac and the phone share them.
 */

/** How many recent models the quick picks lead with. */
export const RECENT_MODELS_MAX = 5;

/** The recent models' file, state/recent-models.json in the loki folder unless LOKI_RECENT_MODELS_FILE says otherwise. */
export const recentModelsFile = (): string => process.env.LOKI_RECENT_MODELS_FILE ?? join(lokiDir(), "state", "recent-models.json");

const handles = (value: unknown): string[] => (Array.isArray(value) ? value.filter((h): h is string => typeof h === "string" && h.length > 0) : []);

/** The handles a recent-models file lists; none when it is missing or not an object with a list. */
function recentIn(file: string): string[] {
  const raw = readJson(file);
  return handles(typeof raw === "object" && raw !== null && "recent" in raw ? raw.recent : null);
}

/** The recent model handles, most recent first and at most RECENT_MODELS_MAX; empty when the file is missing or unreadable. */
export function readRecentModels(file = recentModelsFile()): string[] {
  return recentIn(file).slice(0, RECENT_MODELS_MAX);
}

/** A model picked in loki goes to the front of the list (written atomically); returns the list. */
export function addRecentModel(handle: string, file = recentModelsFile()): string[] {
  const mine = [handle, ...recentIn(file).filter((h) => h !== handle)].slice(0, RECENT_MODELS_MAX);
  writeJsonAtomic(file, { version: 1, recent: mine }, { pretty: true, newline: true, pidTemp: true });
  return mine;
}
