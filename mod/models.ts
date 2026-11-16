import { lokiDir } from "./paths.ts";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./json-file.ts";

export const RECENT_MODELS_MAX = 5;

export const recentModelsFile = (): string => process.env.LOKI_RECENT_MODELS_FILE ?? join(lokiDir(), "state", "recent-models.json");

const handles = (value: unknown): string[] => (Array.isArray(value) ? value.filter((h): h is string => typeof h === "string" && h.length > 0) : []);

function recentIn(file: string): string[] {
  const raw = readJson(file);
  return handles(typeof raw === "object" && raw !== null && "recent" in raw ? raw.recent : null);
}

export function readRecentModels(file = recentModelsFile()): string[] {
  return recentIn(file).slice(0, RECENT_MODELS_MAX);
}

export function addRecentModel(handle: string, file = recentModelsFile()): string[] {
  const mine = [handle, ...recentIn(file).filter((h) => h !== handle)].slice(0, RECENT_MODELS_MAX);
  writeJsonAtomic(file, { version: 1, recent: mine }, { pretty: true, newline: true, pidTemp: true });
  return mine;
}
