import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type * as esbuild from "esbuild";
import { messageOf } from "../../../core/errors.ts";
import { rewriteSharedImports } from "./rewrite.ts";

let esbuildPromise: Promise<typeof esbuild> | null = null;
const loadEsbuild = () => (esbuildPromise ??= import("esbuild"));

const MODULE_CACHE_MAX = 64;
const moduleCache = new Map<string, { mtimeMs: number; size: number; code: string }>();

function cacheSet(key: string, entry: { mtimeMs: number; size: number; code: string }): void {
  if (moduleCache.has(key)) moduleCache.delete(key);
  moduleCache.set(key, entry);
  if (moduleCache.size > MODULE_CACHE_MAX) {
    const oldest = moduleCache.keys().next().value;
    if (oldest !== undefined) moduleCache.delete(oldest);
  }
}

/**
 * A module widget's code as the frame runs it: `<rel>.js` names the widget's `.tsx` or `.jsx` under `widgetsDir`,
 * compiled with React's automatic runtime, its shared imports read from the frame's table. A widget that does not
 * compile becomes a module that throws its file and message; a path that leaves the folder, or names no widget, is null.
 */
export async function widgetModule(widgetsDir: string, rel: string): Promise<string | null> {
  if (rel.includes("..") || rel.startsWith("/") || rel.includes("\\") || rel.includes(":") || !rel.endsWith(".js")) return null;
  const stem = rel.slice(0, -3);
  for (const ext of ["tsx", "jsx"] as const) {
    const file = join(widgetsDir, `${stem}.${ext}`);
    let st;
    try {
      st = await stat(file);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const hit = moduleCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      moduleCache.delete(file);
      moduleCache.set(file, hit);
      return hit.code;
    }
    let code: string;
    try {
      const [{ transform }, source] = await Promise.all([loadEsbuild(), readFile(file, "utf8")]);
      const out = await transform(source, { loader: ext, jsx: "automatic", format: "esm", target: "es2022", sourcefile: file });
      code = rewriteSharedImports(out.code);
    } catch (err) {
      code = `throw new Error(${JSON.stringify(`${file}: ${messageOf(err)}`)});`;
    }
    cacheSet(file, { mtimeMs: st.mtimeMs, size: st.size, code });
    return code;
  }
  return null;
}
