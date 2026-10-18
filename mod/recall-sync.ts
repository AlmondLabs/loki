import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Learn's files the same on every paired Mac (plan 023, U8, R19). Learn keeps one small JSON file per card, schedule,
 * lead and lesson (mod/recall.ts), so it syncs file by file: the later write wins, by the time each file was last
 * written. A card's review schedule is one of those files, so a review on each Mac made apart keeps the later one.
 * A file removed on one Mac is remembered (`.sync.json`) so the other removes it too rather than sending it back.
 */

/** Learn's folders that sync; worker.json and anything else stay on each Mac. */
const FOLDERS = ["cards", "schedule", "rejected", "leads", "leads-dismissed", "lessons"];
const MANIFEST = ".sync.json";

/** One file as it travels: its text and when it was last written (ms). */
export interface RecallFile {
  content: string;
  mtime: number;
}

/** A Mac's Learn files for another, and the ones it removed (path → when, ms). */
export interface RecallSnapshot {
  files: Record<string, RecallFile>;
  deleted: Record<string, number>;
}

interface Manifest {
  /** Every file this Mac had at its last look, with its time: one missing now was removed. */
  known: Record<string, number>;
  deleted: Record<string, number>;
}

function readManifest(dir: string): Manifest {
  try {
    const m = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as Partial<Manifest>;
    return { known: m.known ?? {}, deleted: m.deleted ?? {} };
  } catch {
    return { known: {}, deleted: {} };
  }
}

function writeManifest(dir: string, m: Manifest): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${MANIFEST}.tmp`), JSON.stringify(m));
  renameSync(join(dir, `${MANIFEST}.tmp`), join(dir, MANIFEST));
}

/** The record without one key. */
const without = <T>(o: Record<string, T>, key: string): Record<string, T> => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

/** Every Learn file here, by its path under the Learn folder (forward slashes). */
function listFiles(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const folder of FOLDERS) {
    let names: string[];
    try {
      names = readdirSync(join(dir, folder));
    } catch {
      continue;
    }
    for (const name of names) if (name.endsWith(".json")) out[`${folder}/${name}`] = Math.floor(statSync(join(dir, folder, name)).mtimeMs);
  }
  return out;
}

/** Look again: a file known before and gone now was removed now; then the manifest says what is here. */
function refresh(dir: string, now: number): { files: Record<string, number>; manifest: Manifest } {
  const files = listFiles(dir);
  const manifest = readManifest(dir);
  for (const path of Object.keys(manifest.known)) if (!(path in files)) manifest.deleted[path] = now;
  for (const [path, mtime] of Object.entries(files)) if ((manifest.deleted[path] ?? -1) < mtime) manifest.deleted = without(manifest.deleted, path);
  manifest.known = files;
  writeManifest(dir, manifest);
  return { files, manifest };
}

/** This Mac's Learn files and removals, for a paired Mac. */
export function recallSnapshot(dir: string, now = Date.now()): RecallSnapshot {
  const { files, manifest } = refresh(dir, now);
  const out: Record<string, RecallFile> = {};
  for (const [path, mtime] of Object.entries(files)) {
    try {
      out[path] = { content: readFileSync(join(dir, path), "utf8"), mtime };
    } catch {
      // removed while reading: the next look says so
    }
  }
  return { files: out, deleted: { ...manifest.deleted } };
}

/** Take a paired Mac's Learn files: every later write, every later removal. True when a file here changed. */
export function applyRecall(dir: string, theirs: RecallSnapshot, now = Date.now()): boolean {
  const { files, manifest } = refresh(dir, now);
  const safe = (path: string) => /^[a-z-]+\/[A-Za-z0-9._-]+\.json$/.test(path) && FOLDERS.includes(path.split("/")[0]);
  let moved = false;
  for (const [path, file] of Object.entries(theirs.files)) {
    if (!safe(path) || typeof file.content !== "string" || typeof file.mtime !== "number") continue;
    const mine = Math.max(files[path] ?? -1, manifest.deleted[path] ?? -1);
    if (file.mtime <= mine) continue;
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(`${full}.tmp`, file.content);
    renameSync(`${full}.tmp`, full);
    utimesSync(full, new Date(file.mtime), new Date(file.mtime));
    manifest.known[path] = file.mtime;
    manifest.deleted = without(manifest.deleted, path);
    moved = true;
  }
  for (const [path, at] of Object.entries(theirs.deleted)) {
    if (!safe(path) || typeof at !== "number") continue;
    if ((files[path] ?? -1) >= at || !existsSync(join(dir, path))) {
      if (!(path in files) && (manifest.deleted[path] ?? -1) < at) manifest.deleted[path] = at;
      continue;
    }
    rmSync(join(dir, path), { force: true });
    manifest.known = without(manifest.known, path);
    manifest.deleted[path] = at;
    moved = true;
  }
  writeManifest(dir, manifest);
  return moved;
}
