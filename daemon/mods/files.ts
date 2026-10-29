import { mkdirSync, readdirSync, rmSync, statSync, watch } from "node:fs";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type * as esbuild from "esbuild";
import type { LokiMod } from "./api.ts";
import type { ModRegistry } from "./registry.ts";
import { messageOf } from "../../core/errors.ts";

/**
 * Mods from a folder, reloaded when they change (plan 017, U4). A mod is one file whose default export is a LokiMod,
 * `.js`, `.mjs` or `.ts`. A runtime caches a module by its URL, so each load imports a fresh one: the file is bundled
 * with esbuild to a new file, which also refreshes everything it imports (the technique of mod/boot.ts). Without
 * esbuild (an installed app), a `.js` or `.mjs` mod is imported under a new query instead, which Node treats as new.
 */

const MOD_FILES = new Set([".js", ".mjs", ".ts"]);

let loads = 0;

/** esbuild, when this install has it. */
async function bundler(): Promise<typeof esbuild | null> {
  try {
    return await import("esbuild");
  } catch {
    return null;
  }
}

/** Import one mod file afresh. */
export async function importMod(file: string, buildDir: string): Promise<LokiMod> {
  let url = pathToFileURL(file);
  const esbuild = await bundler();
  if (esbuild) {
    mkdirSync(buildDir, { recursive: true });
    const outfile = join(buildDir, `${basename(file, extname(file))}-${Date.now()}-${loads++}.mjs`);
    await esbuild.build({
      entryPoints: [file],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      packages: "external",
      logLevel: "silent",
    });
    url = pathToFileURL(outfile);
  } else if (extname(file) === ".ts") {
    throw new Error("a .ts mod needs esbuild, which this install does not have; use .mjs");
  } else {
    url.searchParams.set("v", String(loads++));
  }
  const module = (await import(url.href)) as { default?: LokiMod };
  const mod = module.default;
  if (!mod || typeof mod.activate !== "function") throw new Error(`${basename(file)} has no default export with activate()`);
  return { ...mod, name: mod.name || basename(file, extname(file)) };
}

/**
 * Load every mod in `dir` and keep them current: a changed file is loaded again, a removed one unloaded. Returns a
 * function that stops watching.
 */
export async function loadModFolder(mods: ModRegistry, dir: string, report: (message: string) => void): Promise<() => void> {
  mkdirSync(dir, { recursive: true });
  const buildDir = join(dir, ".build");
  rmSync(buildDir, { recursive: true, force: true });
  const names = new Map<string, string>(); // file → mod name
  const loadedAt = new Map<string, number>(); // file → its modification time when last loaded
  const load = async (file: string) => {
    const path = join(dir, file);
    const modified = modifiedAt(path);
    if (modified === null) {
      const name = names.get(file);
      if (name) mods.unload(name);
      names.delete(file);
      loadedAt.delete(file);
      return;
    }
    loadedAt.set(file, modified);
    try {
      const mod = await importMod(path, buildDir);
      // The file renamed its mod: the old name goes, or it would keep running beside the new one.
      const was = names.get(file);
      if (was !== undefined && was !== mod.name) {
        mods.unload(was);
        names.delete(file);
      }
      if ("loaded" in (await mods.load(mod))) names.set(file, mod.name);
    } catch (error) {
      report(`mod ${file} failed to load: ${messageOf(error)}`);
    }
  };
  const isMod = (file: string) => MOD_FILES.has(extname(file)) && !file.startsWith(".");
  // Every file that is new, changed or gone since it was last loaded.
  const sweep = async () => {
    const files = new Set(readdirSync(dir).filter(isMod));
    for (const file of new Set([...files, ...loadedAt.keys()])) if (!files.has(file) || loadedAt.get(file) !== modifiedAt(join(dir, file))) await load(file);
  };
  // Watching starts before the first look, and a second look follows once the watch is surely running: on macOS
  // fs.watch returns before its event stream has started, and a file written in between was never loaded.
  const stop = watchFiles(dir, isMod, load, 150, false);
  await sweep();
  const again = setTimeout(() => {
    sweep().catch((error: unknown) => report(`mods folder not read: ${messageOf(error)}`));
  }, WATCH_SETTLE_MS);
  again.unref();
  return () => {
    clearTimeout(again);
    stop();
  };
}

/** How long after a watch starts the folder is looked at again, for what changed before it was running. */
const WATCH_SETTLE_MS = 1000;

/** A file's modification time in milliseconds, or null when it is gone. */
function modifiedAt(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Call `changed(file)` once a burst of edits to a file under `dir` settles; `file` is relative to `dir`. */
export function watchFiles(dir: string, include: (file: string) => boolean, changed: (file: string) => unknown, settleMs = 150, recursive = true): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const watcher = watch(dir, { recursive }, (_event, file) => {
    if (!file || !include(file)) return;
    clearTimeout(timers.get(file));
    timers.set(
      file,
      setTimeout(() => {
        timers.delete(file);
        void changed(file);
      }, settleMs),
    );
  });
  // The folder removed under it (EPERM on Windows) is emitted as an error, thrown when nobody listens: it stops watching.
  watcher.on("error", () => watcher.close());
  return () => {
    watcher.close();
    for (const t of timers.values()) clearTimeout(t);
  };
}
