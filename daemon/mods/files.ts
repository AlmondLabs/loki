import { existsSync, mkdirSync, readdirSync, rmSync, watch } from "node:fs";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { LokiMod } from "./api.ts";
import type { ModRegistry } from "./registry.ts";

/**
 * Mods from a folder, reloaded when they change (plan 017, U4). A mod is one file whose default export is a LokiMod,
 * `.js`, `.mjs` or `.ts`. A runtime caches a module by its URL, so each load imports a fresh one: the file is bundled
 * with esbuild to a new file, which also refreshes everything it imports (the technique of mod/boot.ts). Without
 * esbuild (an installed app), a `.js` or `.mjs` mod is imported under a new query instead, which Node treats as new.
 */

const MOD_FILES = new Set([".js", ".mjs", ".ts"]);

let loads = 0;

/** esbuild, when this install has it. */
async function bundler(): Promise<typeof import("esbuild") | null> {
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
    await esbuild.build({ entryPoints: [file], outfile, bundle: true, platform: "node", format: "esm", target: "node22", packages: "external", logLevel: "silent" });
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
  const load = async (file: string) => {
    const path = join(dir, file);
    if (!existsSync(path)) {
      const name = names.get(file);
      if (name) mods.unload(name);
      names.delete(file);
      return;
    }
    try {
      const mod = await importMod(path, buildDir);
      if ("loaded" in (await mods.load(mod))) names.set(file, mod.name);
    } catch (error) {
      report(`mod ${file} failed to load: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const isMod = (file: string) => MOD_FILES.has(extname(file)) && !file.startsWith(".");
  for (const file of readdirSync(dir).filter(isMod)) await load(file);
  return watchFiles(dir, isMod, load, 150, false);
}

/** Call `changed(file)` once a burst of edits to a file under `dir` settles; `file` is relative to `dir`. */
export function watchFiles(dir: string, include: (file: string) => boolean, changed: (file: string) => unknown, settleMs = 150, recursive = true): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const watcher = watch(dir, { recursive }, (_event, file) => {
    if (!file || !include(file)) return;
    clearTimeout(timers.get(file));
    timers.set(file, setTimeout(() => {
      timers.delete(file);
      void changed(file);
    }, settleMs));
  });
  return () => {
    watcher.close();
    for (const t of timers.values()) clearTimeout(t);
  };
}
