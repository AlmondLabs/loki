import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Pinned conversations, in the file Letta Desktop keeps: ~/.letta/pinned-conversations.json
 *   { version: 1, agents: { [agentId]: [conversationId, …] } }
 * loki reads and writes the same file, so a pin made here shows in Desktop and vice versa.
 */
export const pinsFile = (): string => process.env.LOKI_PINS_FILE ?? join(homedir(), ".letta", "pinned-conversations.json");

interface PinsDoc {
  version: number;
  agents: Record<string, string[]>;
}

function readDoc(file: string): PinsDoc {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<PinsDoc>;
    const agents: Record<string, string[]> = {};
    for (const [a, list] of Object.entries(raw.agents ?? {})) if (Array.isArray(list)) agents[a] = list.filter((x): x is string => typeof x === "string");
    return { version: typeof raw.version === "number" ? raw.version : 1, agents };
  } catch {
    return { version: 1, agents: {} };
  }
}

/** "agentId/conversationId" for every pin. */
export function readPins(file = pinsFile()): Set<string> {
  const doc = readDoc(file);
  const out = new Set<string>();
  for (const [a, list] of Object.entries(doc.agents)) for (const c of list) out.add(`${a}/${c}`);
  return out;
}

export function isPinned(agentId: string | null, conversationId: string | null, file = pinsFile()): boolean {
  return !!agentId && !!conversationId && readPins(file).has(`${agentId}/${conversationId}`);
}

/** Pin or unpin; writes atomically and keeps the rest of the file as Desktop left it. Returns the new state. */
export function setPin(agentId: string, conversationId: string, pinned: boolean, file = pinsFile()): boolean {
  const doc = readDoc(file);
  const list = doc.agents[agentId] ?? [];
  const has = list.includes(conversationId);
  if (pinned && !has) doc.agents[agentId] = [...list, conversationId];
  if (!pinned && has) doc.agents[agentId] = list.filter((c) => c !== conversationId);
  if (doc.agents[agentId]?.length === 0) delete doc.agents[agentId];
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
  renameSync(tmp, file);
  return pinned;
}
