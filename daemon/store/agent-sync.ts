import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backendName } from "../../core/desk-core.ts";
import { isAgentId } from "../../core/frames.ts";
import { writeRecord } from "./agents.ts";

/**
 * One agent across the person's Macs (plan 023, U3, KTD5, KTD6). Every Mac keeps the same agents under the same ids,
 * so an agent's record travels as it is, field by field: each field carries when and on which Mac it last changed, and
 * the later change wins. Deleting an agent leaves a tombstone that wins over any later change from a Mac that had not
 * heard of the delete. An agent's home Mac (`home_mac`) is a field like the others; a record without one lives on the
 * Mac that has it, which is how every agent from before pairing reads.
 */

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

/** The record fields that sync between Macs. Anything else in a record stays where it is. */
export const SYNCED_FIELDS = ["name", "description", "system", "model", "model_settings", "tags", "hidden", "home_mac"] as const;
/** One of the record fields that sync. */
export type SyncedField = (typeof SYNCED_FIELDS)[number];

const NEVER: Stamp = { at: "", mac: "" };

/** Whether stamp `b` is a later change than `a`: by time, then by Mac id, so two Macs comparing the same pair agree. */
export function later(a: Stamp, b: Stamp): boolean {
  if (b.at !== a.at) return b.at > a.at;
  return b.mac > a.mac;
}

/** A record's stamps, read defensively: a field without one was last changed before anyone stamped it. */
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

/** The record with `fields` stamped as changed now on `mac`. */
export function stamp(record: Record<string, unknown>, fields: readonly SyncedField[], at: Stamp): Record<string, unknown> {
  const changed = { ...stampsOf(record) };
  for (const f of fields) changed[f] = at;
  return { ...record, changed };
}

/** The Mac an agent lives on: its record's `home_mac`, or the Mac reading it when the record names none. */
export function homeOf(record: Record<string, unknown> | null, thisMac: string): string {
  return typeof record?.home_mac === "string" && record.home_mac ? record.home_mac : thisMac;
}

/**
 * `local` with every field `remote` changed later taken from it; null when nothing changes. A record this Mac does
 * not have yet is `remote` itself.
 */
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

/** An agent record file as JSON, or null when it is missing or unreadable. */
export function readRecord(backendDir: string, id: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(readFileSync(join(backendDir, "agents", `${backendName(id)}.json`), "utf8")) as unknown;
    return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The agents this Mac shares: every record of the person's, each with `home_mac` set,
 * a record without one being this Mac's, stamped as older than any change.
 */
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

/** The agents deleted on any Mac, as this Mac knows them. */
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

/** Record an agent's delete, keeping the latest stamp per agent. */
export function addTombstone(backendDir: string, tombstone: Tombstone): void {
  const all = readTombstones(backendDir).filter((t) => t.id !== tombstone.id);
  mkdirSync(backendDir, { recursive: true });
  const file = tombstonesFile(backendDir);
  writeFileSync(`${file}.tmp`, JSON.stringify([...all, tombstone], null, 2));
  renameSync(`${file}.tmp`, file);
}

/** What applying another Mac's agents changed here. */
export interface AppliedAgents {
  /** Records written that this Mac had not got (their memory follows, plan U7). */
  created: string[];
  /** Records that took a later field from the other Mac. */
  updated: string[];
  /** Agents deleted here because the other Mac deleted them. */
  deleted: string[];
}

/**
 * Take another Mac's agents and tombstones: delete what it deleted (a delete wins over any change made since), write
 * records this Mac lacks, and take every field it changed later. `deleteAgent` removes an agent's store, memory
 * and record.
 */
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
