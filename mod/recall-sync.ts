import { existsSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic, writeJsonAtomic } from "./json-file.ts";

const FOLDERS = ["cards", "schedule", "rejected", "leads", "leads-dismissed", "lessons"];
const MANIFEST = ".sync.json";

export interface SyncedFiles {
  list: (dir: string) => Record<string, number>;
  safe: (path: string) => boolean;
}

export interface RecallFile {
  content: string;
  mtime: number;
  encoding?: "base64";
}

/** Strict UTF-8: a byte sequence that is not text fails here rather than being read with replacement characters. */
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function encodeFile(bytes: Buffer, mtime: number): RecallFile {
  try {
    return { content: UTF8.decode(bytes), mtime };
  } catch {
    return { content: bytes.toString("base64"), mtime, encoding: "base64" };
  }
}

export interface RecallSnapshot {
  files: Record<string, RecallFile>;
  deleted: Record<string, number>;
}

interface Manifest {
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
  writeJsonAtomic(join(dir, MANIFEST), m);
}

const without = <T>(o: Record<string, T>, key: string): Record<string, T> => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

function listRecall(dir: string): Record<string, number> {
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

const RECALL: SyncedFiles = {
  list: listRecall,
  safe: (path) => /^[a-z-]+\/[A-Za-z0-9._-]+\.json$/.test(path) && FOLDERS.includes(path.split("/")[0]),
};

function refresh(dir: string, which: SyncedFiles, now: number): { files: Record<string, number>; manifest: Manifest } {
  const files = which.list(dir);
  const manifest = readManifest(dir);
  for (const path of Object.keys(manifest.known)) if (!(path in files)) manifest.deleted[path] = now;
  for (const [path, mtime] of Object.entries(files)) if ((manifest.deleted[path] ?? -1) < mtime) manifest.deleted = without(manifest.deleted, path);
  manifest.known = files;
  writeManifest(dir, manifest);
  return { files, manifest };
}

export function recallSnapshot(dir: string, now = Date.now()): RecallSnapshot {
  return filesSnapshot(dir, RECALL, now);
}

export function applyRecall(dir: string, theirs: RecallSnapshot, now = Date.now()): boolean {
  return applyFiles(dir, RECALL, theirs, now);
}

export function filesSnapshot(dir: string, which: SyncedFiles, now = Date.now()): RecallSnapshot {
  const { files, manifest } = refresh(dir, which, now);
  const out: Record<string, RecallFile> = {};
  for (const [path, mtime] of Object.entries(files)) {
    try {
      out[path] = encodeFile(readFileSync(join(dir, path)), mtime);
    } catch {}
  }
  return { files: out, deleted: { ...manifest.deleted } };
}

export function applyFiles(dir: string, which: SyncedFiles, theirs: RecallSnapshot, now = Date.now()): boolean {
  const { files, manifest } = refresh(dir, which, now);
  const { safe } = which;
  let moved = false;
  for (const [path, file] of Object.entries(theirs.files)) {
    if (!safe(path) || typeof file.content !== "string" || typeof file.mtime !== "number") continue;
    const mine = Math.max(files[path] ?? -1, manifest.deleted[path] ?? -1);
    if (file.mtime <= mine) continue;
    const full = join(dir, path);
    writeFileAtomic(full, file.encoding === "base64" ? Buffer.from(file.content, "base64") : file.content);
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
