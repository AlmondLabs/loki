import { lokiDir } from "./paths.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./json-file.ts";

export const pinsFile = (): string => process.env.LOKI_PINS_FILE ?? join(lokiDir(), "state", "pins.json");

interface PinsDoc {
  version: number;
  agents: Record<string, string[]>;
  changed: Record<string, PinChange>;
}

export interface PinChange {
  pinned: boolean;
  at: string;
}

const LONG_AGO = "1970-01-01T00:00:00.000Z";

function readDoc(file: string): PinsDoc {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<PinsDoc>;
    const agents: Record<string, string[]> = {};
    for (const [a, list] of Object.entries(raw.agents ?? {})) if (Array.isArray(list)) agents[a] = list.filter((x): x is string => typeof x === "string");
    const changed: Record<string, PinChange> = {};
    for (const [k, c] of Object.entries(raw.changed ?? {}))
      if (typeof c === "object" && typeof c.pinned === "boolean" && typeof c.at === "string") changed[k] = { pinned: c.pinned, at: c.at };
    return { version: typeof raw.version === "number" ? raw.version : 1, agents, changed };
  } catch {
    return { version: 1, agents: {}, changed: {} };
  }
}

const writeDoc = (doc: PinsDoc, file: string) => writeJsonAtomic(file, doc, { pretty: true, newline: true, pidTemp: true });

function place(doc: PinsDoc, agentId: string, conversationId: string, pinned: boolean): void {
  const list = doc.agents[agentId] ?? [];
  const has = list.includes(conversationId);
  if (pinned && !has) doc.agents[agentId] = [...list, conversationId];
  if (!pinned && has) doc.agents[agentId] = list.filter((c) => c !== conversationId);
  if (Object.hasOwn(doc.agents, agentId) && doc.agents[agentId].length === 0) {
    const { [agentId]: _, ...others } = doc.agents;
    doc.agents = others;
  }
}

export function pinChanges(file = pinsFile()): Record<string, PinChange> {
  const doc = readDoc(file);
  const out: Record<string, PinChange> = {};
  for (const key of readPins(file)) out[key] = { pinned: true, at: LONG_AGO };
  return { ...out, ...doc.changed };
}

export function applyPinChanges(theirs: Record<string, PinChange>, file = pinsFile()): boolean {
  const doc = readDoc(file);
  const mine: Partial<Record<string, PinChange>> = pinChanges(file);
  let moved = false;
  for (const [key, c] of Object.entries(theirs)) {
    const slash = key.indexOf("/");
    if (slash <= 0 || typeof c.at !== "string" || typeof c.pinned !== "boolean") continue;
    const ours = mine[key];
    if (ours && ours.at >= c.at) continue;
    place(doc, key.slice(0, slash), key.slice(slash + 1), c.pinned);
    doc.changed[key] = { pinned: c.pinned, at: c.at };
    moved = true;
  }
  if (moved) writeDoc(doc, file);
  return moved;
}

export function readPins(file = pinsFile()): Set<string> {
  const doc = readDoc(file);
  const out = new Set<string>();
  for (const [a, list] of Object.entries(doc.agents)) for (const c of list) out.add(`${a}/${c}`);
  return out;
}

export function setPin(agentId: string, conversationId: string, pinned: boolean, file = pinsFile(), now = () => new Date().toISOString()): boolean {
  const doc = readDoc(file);
  place(doc, agentId, conversationId, pinned);
  doc.changed[`${agentId}/${conversationId}`] = { pinned, at: now() };
  writeDoc(doc, file);
  return pinned;
}
