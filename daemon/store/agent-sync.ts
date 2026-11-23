import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { backendName } from "../../core/desk-core.ts";
import { isAgentId } from "../../core/frames.ts";
import { writeRecord } from "./agents.ts";
import { writeJsonAtomic } from "../../mod/json-file.ts";

/** When and where a field last changed. `at` is ISO time; "" is "before anyone stamped it", older than any change. */
export interface Stamp {
  at: string;
  mac: string;
}

/** An agent's record as it goes between Macs: the record file's own JSON, with its `changed` stamps and `home_mac`. */
export interface SharedAgent {
  id: string;
  record: Record<string, unknown>;
}

/** A deleted agent, so a Mac that still has it deletes it too rather than sending it back. */
export interface Tombstone extends Stamp {
  id: string;
}

export const SYNCED_FIELDS = [
  "name",
  "description",
  "system",
  "model",
  "model_settings",
  "tags",
  "hidden",
  "home_mac",
  "advisor_model",
  "advisor_reasoning_effort",
] as const;
export type SyncedField = (typeof SYNCED_FIELDS)[number];

const NEVER: Stamp = { at: "", mac: "" };

export function later(a: Stamp, b: Stamp): boolean {
  if (b.at !== a.at) return b.at > a.at;
  return b.mac > a.mac;
}

export function stampsOf(record: Record<string, unknown>): Partial<Record<SyncedField, Stamp>> {
  const raw = record.changed;
  if (typeof raw !== "object" || raw === null) return {};
  const out: Partial<Record<SyncedField, Stamp>> = {};
  for (const f of SYNCED_FIELDS) {
    const s = (raw as Record<string, unknown>)[f] as Partial<Stamp> | undefined;
    if (s && typeof s.at === "string" && typeof s.mac === "string") out[f] = { at: s.at, mac: s.mac };
  }
  return out;
}

export function stamp(record: Record<string, unknown>, fields: readonly SyncedField[], at: Stamp): Record<string, unknown> {
  const changed = { ...stampsOf(record) };
  for (const f of fields) changed[f] = at;
  return { ...record, changed };
}

export function homeOf(record: Record<string, unknown> | null, thisMac: string): string {
  return typeof record?.home_mac === "string" && record.home_mac ? record.home_mac : thisMac;
}

export function merge(local: Record<string, unknown> | null, remote: Record<string, unknown>): Record<string, unknown> | null {
  if (!local) return remote;
  const mine = stampsOf(local);
  const theirs = stampsOf(remote);
  const next: Record<string, unknown> = { ...local };
  const changed = { ...mine };
  let moved = false;
  for (const f of SYNCED_FIELDS) {
    const t = theirs[f];
    if (!t || !later(mine[f] ?? NEVER, t)) continue;
    next[f] = remote[f];
    changed[f] = t;
    moved = true;
  }
  return moved ? { ...next, changed } : null;
}

export function readRecord(backendDir: string, id: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(readFileSync(join(backendDir, "agents", `${backendName(id)}.json`), "utf8")) as unknown;
    return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function sharedAgents(backendDir: string, thisMac: string): SharedAgent[] {
  let ids: string[];
  try {
    ids = readdirSync(join(backendDir, "memfs"));
  } catch {
    return [];
  }
  return ids.flatMap((id) => {
    const record = isAgentId(id) ? readRecord(backendDir, id) : null;
    if (!record || isHelper(record)) return [];
    if (typeof record.home_mac === "string" && record.home_mac) return [{ id, record }];
    return [{ id, record: { ...record, home_mac: thisMac, changed: { ...stampsOf(record), home_mac: { at: "", mac: thisMac } } } }];
  });
}

const isHelper = (record: Record<string, unknown>) =>
  Array.isArray(record.tags) && record.tags.some((t) => typeof t === "string" && (t === "role:subagent" || t.startsWith("role:subagent:")));

const tombstonesFile = (backendDir: string) => join(backendDir, "tombstones.json");

export function readTombstones(backendDir: string): Tombstone[] {
  try {
    const raw = JSON.parse(readFileSync(tombstonesFile(backendDir), "utf8")) as unknown;
    return Array.isArray(raw)
      ? raw.filter((t): t is Tombstone => typeof t === "object" && t !== null && isAgentId((t as Tombstone).id) && typeof (t as Tombstone).at === "string")
      : [];
  } catch {
    return [];
  }
}

export function addTombstone(backendDir: string, tombstone: Tombstone): void {
  const all = readTombstones(backendDir).filter((t) => t.id !== tombstone.id);
  writeJsonAtomic(tombstonesFile(backendDir), [...all, tombstone], { pretty: true });
}

export interface AppliedAgents {
  created: string[];
  updated: string[];
  deleted: string[];
}

export async function applyShared(
  backendDir: string,
  remote: { agents: SharedAgent[]; tombstones: Tombstone[] },
  deleteAgent: (id: string) => Promise<void>,
): Promise<AppliedAgents> {
  const out: AppliedAgents = { created: [], updated: [], deleted: [] };
  const known = new Map(readTombstones(backendDir).map((t) => [t.id, t]));
  for (const t of remote.tombstones) {
    if (!isAgentId(t.id)) continue;
    const mine = known.get(t.id);
    if (!mine || later(mine, t)) {
      addTombstone(backendDir, t);
      known.set(t.id, t);
    }
    if (readRecord(backendDir, t.id)) {
      await deleteAgent(t.id);
      out.deleted.push(t.id);
    }
  }
  for (const { id, record } of remote.agents) {
    if (!isAgentId(id) || known.has(id)) continue;
    const local = readRecord(backendDir, id);
    const next = merge(local, { ...record, id });
    if (!next) continue;
    writeRecord(backendDir, id, next);
    (local ? out.updated : out.created).push(id);
  }
  return out;
}
