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

async function bundler(): Promise<typeof esbuild | null> {
  try {
    return await import("esbuild");
  } catch {
    return null;
  }
}

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

export async function loadModFolder(mods: ModRegistry, dir: string, report: (message: string) => void): Promise<() => void> {
  mkdirSync(dir, { recursive: true });
  const buildDir = join(dir, ".build");
  rmSync(buildDir, { recursive: true, force: true });
  const names = new Map<string, string>();
  const loadedAt = new Map<string, number>();
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
      if (mod.name === "loki") {
        report(`mod ${file} failed to load: "loki" is reserved for loki's built-in mod`);
        return;
      }
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
  const sweep = async () => {
    const files = new Set(readdirSync(dir).filter(isMod));
    for (const file of new Set([...files, ...loadedAt.keys()])) if (!files.has(file) || loadedAt.get(file) !== modifiedAt(join(dir, file))) await load(file);
  };
  // Outside (macOS): fs.watch returns before its event stream has started, so watching starts before the first look,
  // and a second look follows once the watch is surely running.
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

const WATCH_SETTLE_MS = 1000;

function modifiedAt(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

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
  // Outside (Node): the folder removed under it (EPERM on Windows) is emitted as an error, thrown when nobody listens: it stops watching.
  watcher.on("error", () => watcher.close());
  return () => {
    watcher.close();
    for (const t of timers.values()) clearTimeout(t);
  };
}
