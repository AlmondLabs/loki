import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../mod/json-file.ts";
import { isRecord } from "./tool-kinds.ts";

const LAST_CONVERTING_RELEASE = "2026.1116";
const LAST_STORE_CONVERSION = 3;
const SAVED_STATE = ["approvals.json", "desks.json", "devices.json", "passes.json", "pass-cursors.json"];

export type OldDataVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Whether this build may open a loki folder. Builds up to 2026.1116 converted older data as they started; this one no
 * longer does, so data no such build has started is refused rather than read wrongly.
 *
 * `state/migrations.json`: `agents` (a number, 1 or more) was written at first start by every daemon from 2026-10-28
 * until the conversions went, and is written by this check on a folder with no loki data yet; other keys are kept.
 * `stores/migrations.json`: `<agent id>.sqlite` → the last conversion a store went through, written by those same
 * builds and read only here. Only listed agents' stores that still exist count: an entry outlives its deleted agent,
 * and 2026.1116 never opens an unlisted agent's store.
 */
export function checkOldData(d: { stateDir: string; storesDir: string; agents: readonly string[] }): OldDataVerdict {
  const markerFile = join(d.stateDir, "migrations.json");
  const read = readJson(markerFile);
  const marker = isRecord(read) ? read : {};
  if (typeof marker.agents === "number" && marker.agents >= 1) return storesConverted(d);
  if (d.agents.length > 0 || hasStores(d.storesDir) || SAVED_STATE.some((name) => existsSync(join(d.stateDir, name)))) {
    return refuse("its data was last used by a loki older than that");
  }
  writeJsonAtomic(markerFile, { ...marker, agents: 1 }, { pretty: true, newline: true });
  return { ok: true };
}

function storesConverted(d: { storesDir: string; agents: readonly string[] }): OldDataVerdict {
  const read = readJson(join(d.storesDir, "migrations.json"));
  const marks = isRecord(read) ? read : {};
  const behind = d.agents
    .map((agent) => `${agent}.sqlite`)
    .filter((name) => {
      const mark = marks[name];
      return typeof mark === "number" && mark < LAST_STORE_CONVERSION && existsSync(join(d.storesDir, name));
    });
  return behind.length === 0 ? { ok: true } : refuse(`it did not finish converting ${behind.join(", ")} in ${d.storesDir}`);
}

function hasStores(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => name.endsWith(".sqlite"));
  } catch {
    return false;
  }
}

const refuse = (why: string): OldDataVerdict => ({
  ok: false,
  reason: `this loki folder needs loki ${LAST_CONVERTING_RELEASE} first: ${why}. Install loki ${LAST_CONVERTING_RELEASE}, start it once, then update again`,
});
