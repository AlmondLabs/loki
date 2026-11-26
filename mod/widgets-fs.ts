import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import type * as esbuild from "esbuild";
import { join } from "node:path";
import type { Scope, WidgetKind, WidgetManifestEntry } from "../core/canvas-core.ts";
import { KIT } from "../core/canvas-core.ts";
import { serialQueue } from "../core/serial.ts";
import { debounce } from "../core/timers.ts";
import { messageOf } from "../core/errors.ts";

const MODULE_EXT = new Set([".tsx", ".jsx"]);

export interface WidgetsDiff {
  added: WidgetManifestEntry[];
  changed: WidgetManifestEntry[];
  removed: string[];
  removedEntries: WidgetManifestEntry[];
  initial: boolean;
}

export function parseJsonWidget(text: string): {
  title?: string;
  type?: string;
  data: Record<string, unknown>;
  error?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { data: {}, error: `invalid JSON: ${messageOf(err)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { data: {}, error: "widget file must be a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : undefined;
  const title = typeof obj.title === "string" ? obj.title : undefined;
  const data = typeof obj.data === "object" && obj.data !== null && !Array.isArray(obj.data) ? (obj.data as Record<string, unknown>) : {};
  if (!type) return { title, data, error: `missing "type" — one of: ${Object.keys(KIT).join(", ")}` };
  if (!Object.hasOwn(KIT, type)) return { title, type, data, error: `unknown type "${type}" — one of: ${Object.keys(KIT).join(", ")}` };
  if (!title) return { type, data, error: 'missing "title"' };
  return { title, type, data };
}

export function titleFromModule(source: string): string | null {
  const m = /export\s+const\s+title\s*(?::\s*string\s*)?=\s*(["'`])([^"'`\n]+)\1/.exec(source);
  return m ? m[2] : null;
}

type Esbuild = typeof esbuild;
let esbuildPromise: Promise<Esbuild | null> | undefined;
const loadEsbuild = (): Promise<Esbuild | null> => (esbuildPromise ??= import("esbuild").catch(() => null));

export async function checkModule(source: string, file: string): Promise<string | null> {
  try {
    const esbuild = await loadEsbuild();
    if (esbuild) await esbuild.transform(source, { loader: "tsx", jsx: "automatic", sourcefile: file, logLevel: "silent" });
    if (!/export\s+default\b/.test(source)) return "module has no default export (export default a React component)";
    return null;
  } catch (err) {
    const e = err as { errors?: Array<{ text: string; location?: { line: number; column: number } | null }> };
    if (e.errors?.length) {
      return e.errors.map((x) => (x.location ? `${file}:${x.location.line}:${x.location.column}: ${x.text}` : x.text)).join("\n");
    }
    return messageOf(err);
  }
}

function hashOf(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

function splitName(fileName: string): { stem: string; ext: string } | null {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || fileName.startsWith(".")) return null;
  return { stem: fileName.slice(0, dot), ext: fileName.slice(dot) };
}

export type ScanCache = Map<string, { mtime: number; size: number; entry: WidgetManifestEntry }>;

async function readEntry(
  root: string,
  scope: Scope,
  fileName: string,
  cache?: ScanCache,
): Promise<{ entry: WidgetManifestEntry; mtime: number; size: number } | null> {
  const parts = splitName(fileName);
  if (!parts) return null;
  let kind: WidgetKind;
  if (parts.ext === ".json") kind = "json";
  else if (MODULE_EXT.has(parts.ext)) kind = "module";
  else return null;

  const abs = join(root, scope, fileName);
  let text: string;
  let mtime: number;
  let size: number;
  try {
    const st = statSync(abs);
    mtime = st.mtimeMs;
    size = st.size;
    const seen = cache?.get(abs);
    if (seen?.mtime === mtime && seen.size === size) return { entry: seen.entry, mtime, size };
    text = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  const id = `${scope}/${parts.stem}`;
  const base = { id, scope, name: parts.stem, kind, file: `${scope}/${fileName}`, hash: hashOf(text), updated_at: mtime };

  if (kind === "json") {
    const p = parseJsonWidget(text);
    return { entry: { ...base, title: p.title ?? parts.stem, type: p.type, data: p.data, ...(p.error ? { error: p.error } : {}) }, mtime, size };
  }
  const error = await checkModule(text, base.file);
  return { entry: { ...base, title: titleFromModule(text) ?? parts.stem, data: {}, ...(error ? { error } : {}) }, mtime, size };
}

async function readCached(root: string, scope: Scope, fileName: string, cache?: ScanCache): Promise<WidgetManifestEntry | null> {
  const result = await readEntry(root, scope, fileName, cache);
  const abs = join(root, scope, fileName);
  if (!cache) return result?.entry ?? null;
  if (!result) cache.delete(abs);
  else if (cache.get(abs)?.entry !== result.entry) cache.set(abs, { mtime: result.mtime, size: result.size, entry: result.entry });
  return result?.entry ?? null;
}

export async function scanWidgets(root: string, cache?: ScanCache): Promise<Map<string, WidgetManifestEntry>> {
  const out = new Map<string, WidgetManifestEntry>();
  const list = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  if (!existsSync(root)) {
    cache?.clear();
    return out;
  }
  const seen = cache ? new Set<string>() : null;
  for (const scopeDir of list(root)) {
    if (!scopeDir.isDirectory() || scopeDir.name.startsWith(".")) continue;
    const files = list(join(root, scopeDir.name)).filter((f) => f.isFile());
    const entries = await Promise.all(
      files.map(async (f) => {
        seen?.add(join(root, scopeDir.name, f.name));
        return readCached(root, scopeDir.name, f.name, cache);
      }),
    );
    for (const entry of entries) if (entry) out.set(entry.id, entry);
  }
  if (cache && seen) for (const abs of [...cache.keys()]) if (!seen.has(abs)) cache.delete(abs);
  return out;
}

export interface WidgetsWatcher {
  entries(scope?: Scope): WidgetManifestEntry[];
  get(id: string): WidgetManifestEntry | undefined;
  setRuntimeError(id: string, message: string | null): boolean;
  rescan(): Promise<void>;
  close(): void;
}

export function watchWidgets(root: string, onDiff: (diff: WidgetsDiff) => void, opts: { debounceMs?: number } = {}): WidgetsWatcher {
  const debounceMs = opts.debounceMs ?? 80;
  mkdirSync(root, { recursive: true });

  let index = new Map<string, WidgetManifestEntry>();
  const cache: ScanCache = new Map();
  const runtimeErrors = new Map<string, string>();
  const scans = serialQueue();
  let closed = false;

  const merged = (e: WidgetManifestEntry): WidgetManifestEntry => {
    const rt = runtimeErrors.get(e.id);
    return rt && !e.error ? { ...e, error: rt } : e;
  };

  let first = true;

  const doScan = async (): Promise<void> => {
    if (closed) return;
    const next = await scanWidgets(root, cache);
    const diff: WidgetsDiff = { added: [], changed: [], removed: [], removedEntries: [], initial: first };
    first = false;
    for (const [id, e] of next) {
      const prev = index.get(id);
      if (!prev) diff.added.push(e);
      else if (prev.hash !== e.hash) {
        diff.changed.push(e);
        runtimeErrors.delete(id);
      }
    }
    for (const [id, e] of index) {
      if (next.has(id)) continue;
      diff.removed.push(id);
      diff.removedEntries.push(e);
    }
    index = next;
    if (diff.added.length || diff.changed.length || diff.removed.length) onDiff(diff);
  };

  const settling = debounce(() => void rescan(), debounceMs);

  const rescan = (): Promise<void> => {
    return scans(doScan);
  };

  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(root, { recursive: true }, () => {
      settling.schedule();
    });
    // Outside (Node): the folder removed under it (EPERM on Windows) is emitted as an error, thrown when nobody
    // listens; tools still call rescan() themselves.
    watcher.on("error", () => {
      watcher?.close();
      watcher = null;
    });
  } catch {}
  void rescan();

  return {
    entries: (scope) => [...index.values()].filter((e) => !scope || e.scope === scope).map(merged),
    get: (id) => {
      const e = index.get(id);
      return e ? merged(e) : undefined;
    },
    setRuntimeError(id, message) {
      const prev = runtimeErrors.get(id) ?? null;
      if (prev === message) return false;
      if (message) runtimeErrors.set(id, message);
      else runtimeErrors.delete(id);
      return true;
    },
    rescan,
    close() {
      closed = true;
      settling.cancel();
      watcher?.close();
    },
  };
}
