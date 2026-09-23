import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Scope, WidgetKind, WidgetManifestEntry } from "../core/desk-core.ts";
import { KIT } from "../core/desk-core.ts";

/**
 * The widgets directory is the agent's half of the desk. This module turns
 * <root>/<scope>/<name>.json|.tsx into manifest entries, syntax-checks modules
 * with esbuild so the agent hears about a broken file without a tab open, and
 * watches for changes.
 */

const MODULE_EXT = new Set([".tsx", ".jsx"]);

export interface WidgetsDiff {
  added: WidgetManifestEntry[];
  changed: WidgetManifestEntry[];
  removed: string[];
  /** The entries behind `removed`, as they were before the file went (for the change log's title). */
  removedEntries: WidgetManifestEntry[];
  /** The watcher's first scan: what was already on disk when the mod started, not a fresh write. */
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
    return { data: {}, error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { data: {}, error: "widget file must be a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : undefined;
  const title = typeof obj.title === "string" ? obj.title : undefined;
  const data =
    typeof obj.data === "object" && obj.data !== null && !Array.isArray(obj.data)
      ? (obj.data as Record<string, unknown>)
      : {};
  if (!type) return { title, data, error: `missing "type" — one of: ${Object.keys(KIT).join(", ")}` };
  if (!KIT[type]) return { title, type, data, error: `unknown type "${type}" — one of: ${Object.keys(KIT).join(", ")}` };
  if (!title) return { type, data, error: 'missing "title"' };
  return { title, type, data };
}

/** `export const title = "…"` in a module, if present. */
export function titleFromModule(source: string): string | null {
  const m = /export\s+const\s+title\s*(?::\s*string\s*)?=\s*(["'`])([^"'`\n]+)\1/.exec(source);
  return m ? m[2] : null;
}

/**
 * esbuild is a development dependency of the repo; the mod the app installs is a single bundle
 * without node_modules, so the checker loads it lazily and does without when it is absent (the
 * app's own transpiler still reports a broken file inside the widget's frame).
 */
type Esbuild = typeof import("esbuild");
let esbuildPromise: Promise<Esbuild | null> | undefined;
const loadEsbuild = (): Promise<Esbuild | null> => (esbuildPromise ??= import("esbuild").catch(() => null));

/** Syntax-check a TSX module. Returns esbuild's message or null. */
export async function checkModule(source: string, file: string): Promise<string | null> {
  try {
    const esbuild = await loadEsbuild();
    if (esbuild) await esbuild.transform(source, { loader: "tsx", jsx: "automatic", sourcefile: file, logLevel: "silent" });
    if (!/export\s+default\b/.test(source)) return "module has no default export (export default a React component)";
    return null;
  } catch (err) {
    const e = err as { errors?: Array<{ text: string; location?: { line: number; column: number } | null }> };
    if (e.errors?.length) {
      return e.errors
        .map((x) => (x.location ? `${file}:${x.location.line}:${x.location.column}: ${x.text}` : x.text))
        .join("\n");
    }
    return err instanceof Error ? err.message : String(err);
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

async function readEntry(root: string, scope: Scope, fileName: string): Promise<WidgetManifestEntry | null> {
  const parts = splitName(fileName);
  if (!parts) return null;
  let kind: WidgetKind;
  if (parts.ext === ".json") kind = "json";
  else if (MODULE_EXT.has(parts.ext)) kind = "module";
  else return null;

  const abs = join(root, scope, fileName);
  let text: string;
  let mtime: number;
  try {
    text = readFileSync(abs, "utf8");
    mtime = statSync(abs).mtimeMs;
  } catch {
    return null;
  }
  const id = `${scope}/${parts.stem}`;
  const base = { id, scope, name: parts.stem, kind, file: `${scope}/${fileName}`, hash: hashOf(text), updatedAt: mtime };

  if (kind === "json") {
    const p = parseJsonWidget(text);
    return { ...base, title: p.title ?? parts.stem, type: p.type, data: p.data, ...(p.error ? { error: p.error } : {}) };
  }
  const error = await checkModule(text, base.file);
  return { ...base, title: titleFromModule(text) ?? parts.stem, data: {}, ...(error ? { error } : {}) };
}

/** Read every widget file under root. */
export async function scanWidgets(root: string): Promise<Map<string, WidgetManifestEntry>> {
  const out = new Map<string, WidgetManifestEntry>();
  const list = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return []; // removed mid-scan (the agent deleted a desk): treat as empty
    }
  };
  if (!existsSync(root)) return out;
  for (const scopeDir of list(root)) {
    if (!scopeDir.isDirectory() || scopeDir.name.startsWith(".")) continue;
    for (const f of list(join(root, scopeDir.name))) {
      if (!f.isFile()) continue;
      const entry = await readEntry(root, scopeDir.name, f.name);
      if (entry) out.set(entry.id, entry);
    }
  }
  return out;
}

export interface WidgetsWatcher {
  /** Current manifest, runtime errors merged in. */
  entries(scope?: Scope): WidgetManifestEntry[];
  get(id: string): WidgetManifestEntry | undefined;
  /** Runtime error reported by a tab (null clears). Returns true if it changed. */
  setRuntimeError(id: string, message: string | null): boolean;
  /** Force a rescan now (tests). */
  rescan(): Promise<void>;
  close(): void;
}

export function watchWidgets(
  root: string,
  onDiff: (diff: WidgetsDiff) => void,
  opts: { debounceMs?: number } = {},
): WidgetsWatcher {
  const debounceMs = opts.debounceMs ?? 80;
  mkdirSync(root, { recursive: true });

  let index = new Map<string, WidgetManifestEntry>();
  const runtimeErrors = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  let closed = false;

  const merged = (e: WidgetManifestEntry): WidgetManifestEntry => {
    const rt = runtimeErrors.get(e.id);
    return rt && !e.error ? { ...e, error: rt } : e;
  };

  let first = true;

  const doScan = async (): Promise<void> => {
    if (closed) return;
    const next = await scanWidgets(root);
    const diff: WidgetsDiff = { added: [], changed: [], removed: [], removedEntries: [], initial: first };
    first = false;
    for (const [id, e] of next) {
      const prev = index.get(id);
      if (!prev) diff.added.push(e);
      else if (prev.hash !== e.hash) {
        diff.changed.push(e);
        runtimeErrors.delete(id); // file changed: stale runtime error
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

  /** Scans run one at a time; each caller's promise resolves after a scan that started after the call. */
  const rescan = (): Promise<void> => {
    chain = chain.then(doScan, doScan);
    return chain;
  };

  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(root, { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void rescan();
      }, debounceMs);
    });
  } catch {
    // no watcher: tools call rescan() explicitly
  }
  void rescan();

  return {
    entries: (scope) =>
      [...index.values()].filter((e) => !scope || e.scope === scope).map(merged),
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
      if (timer) clearTimeout(timer);
      watcher?.close();
    },
  };
}
