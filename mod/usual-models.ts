import { join } from "node:path";
import { isReasoningEffort, type ReasoningEffort } from "../core/models.ts";
import { readJson, writeJsonAtomic } from "./json-file.ts";
import { lokiDir } from "./paths.ts";

export const USUAL_MAX = 3;

/** One kept configuration: the model, its effort (null when it takes none), the switches to it, and the last one's time. */
export interface UsualModel {
  handle: string;
  reasoning_effort: ReasoningEffort | null;
  uses: number;
  at: string;
}

/** Every agent's usual models, by agent id, most used first. */
export type UsualModels = Record<string, UsualModel[]>;

export const usualModelsFile = (): string => process.env.LOKI_USUAL_MODELS_FILE ?? join(lokiDir(), "state", "usual-models.json");

function usualOf(value: unknown): UsualModel | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.handle !== "string" || !v.handle) return null;
  const effort = isReasoningEffort(v.reasoning_effort) ? v.reasoning_effort : null;
  const uses = typeof v.uses === "number" && Number.isFinite(v.uses) && v.uses > 0 ? Math.floor(v.uses) : 1;
  return { handle: v.handle, reasoning_effort: effort, uses, at: typeof v.at === "string" ? v.at : "" };
}

const ranked = (list: UsualModel[]): UsualModel[] => [...list].sort((a, b) => b.uses - a.uses || b.at.localeCompare(a.at));

export function readUsualModels(file = usualModelsFile()): UsualModels {
  const raw = readJson(file);
  const agents = typeof raw === "object" && raw !== null && "agents" in raw ? raw.agents : null;
  if (typeof agents !== "object" || agents === null) return {};
  const out: UsualModels = {};
  for (const [id, list] of Object.entries(agents)) {
    const kept = Array.isArray(list) ? list.map(usualOf).filter((u): u is UsualModel => u !== null) : [];
    if (kept.length) out[id] = ranked(kept).slice(0, USUAL_MAX);
  }
  return out;
}

export function topUsualModel(agentId: string, file = usualModelsFile()): UsualModel | null {
  const all = readUsualModels(file);
  return Object.hasOwn(all, agentId) ? (all[agentId].at(0) ?? null) : null;
}

export function recordUsualModel(agentId: string, handle: string, effort: ReasoningEffort | null, now: Date, file = usualModelsFile()): UsualModels {
  const all = readUsualModels(file);
  const at = now.toISOString();
  const mine = Object.hasOwn(all, agentId) ? all[agentId] : [];
  const same = mine.find((u) => u.handle === handle && u.reasoning_effort === effort);
  const next = same
    ? mine.map((u) => (u === same ? { ...u, uses: u.uses + 1, at } : u))
    : [...ranked(mine).slice(0, USUAL_MAX - 1), { handle, reasoning_effort: effort, uses: 1, at }];
  all[agentId] = ranked(next).slice(0, USUAL_MAX);
  writeJsonAtomic(file, { version: 1, agents: all }, { pretty: true, newline: true, pidTemp: true });
  return all;
}
