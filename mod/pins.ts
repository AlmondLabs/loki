import { lokiDir } from "./paths.ts";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Pinned conversations, in <loki>/state/pins.json (the import copied Letta Desktop's pins in once):
 *   { version: 1, agents: { [agentId]: [conversationId, …] }, changed?: { "agentId/conversationId": {pinned, at} } }
 * `changed` says when each pin was last set or cleared (plan 023, U8), so paired Macs keep the later; a pin from
 * before it reads as set long ago, which any change made since beats.
 */
export const pinsFile = (): string => process.env.LOKI_PINS_FILE ?? join(lokiDir(), "state", "pins.json");

interface PinsDoc {
  version: number;
  agents: Record<string, string[]>;
  changed: Record<string, PinChange>;
}

/** When a pin was last set or cleared, and which. */
export interface PinChange {
  pinned: boolean;
  at: string;
}

/** The time a pin from before pins had times is taken to have been set at. */
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

function writeDoc(doc: PinsDoc, file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
  renameSync(tmp, file);
}

/** Put one pin in or take it out of the agents map; the map keeps no empty lists. */
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

/** Every pin's last change, for a paired Mac: pins from before times count as set long ago. */
export function pinChanges(file = pinsFile()): Record<string, PinChange> {
  const doc = readDoc(file);
  const out: Record<string, PinChange> = {};
  for (const key of readPins(file)) out[key] = { pinned: true, at: LONG_AGO };
  return { ...out, ...doc.changed };
}

/** Take a paired Mac's pin changes: each later one is applied here with its own time. True when a pin moved. */
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

/** "agentId/conversationId" for every pin. */
export function readPins(file = pinsFile()): Set<string> {
  const doc = readDoc(file);
  const out = new Set<string>();
  for (const [a, list] of Object.entries(doc.agents)) for (const c of list) out.add(`${a}/${c}`);
  return out;
}

/** Whether the conversation is pinned; false when either id is missing. */
export function isPinned(agentId: string | null, conversationId: string | null, file = pinsFile()): boolean {
  return !!agentId && !!conversationId && readPins(file).has(`${agentId}/${conversationId}`);
}

/** Pin or unpin; writes atomically and keeps the rest of the file as Desktop left it. Returns the new state. */
export function setPin(agentId: string, conversationId: string, pinned: boolean, file = pinsFile(), now = () => new Date().toISOString()): boolean {
  const doc = readDoc(file);
  place(doc, agentId, conversationId, pinned);
  doc.changed[`${agentId}/${conversationId}`] = { pinned, at: now() };
  writeDoc(doc, file);
  return pinned;
}
