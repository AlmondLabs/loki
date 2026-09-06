import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

/**
 * Entry for the ~/.letta/mods shim. Node caches ES modules by URL for the life
 * of the process, so re-importing mod.ts with a fresh query only refreshes
 * mod.ts itself — every file it imports would still be the old copy. Bundling
 * the mod's own files into a uniquely named file on each activate gives
 * /reload a genuinely fresh module graph. node_modules stay external and
 * resolve from the project because the bundle is written inside it.
 */
export default async function activate(letta: unknown): Promise<unknown> {
  const here = fileURLToPath(new URL(import.meta.url)); // query stripped by fileURLToPath
  const root = dirname(dirname(here));
  const outDir = join(root, ".loki-build");
  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, `mod-${Date.now()}.mjs`);

  await esbuild.build({
    entryPoints: [join(root, "mod", "mod.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
    sourcemap: "inline",
    logLevel: "silent",
  });

  // keep the directory small; the running instance already holds its module in memory
  try {
    for (const f of readdirSync(outDir)) {
      const p = join(outDir, f);
      if (p !== outfile && f.startsWith("mod-") && existsSync(p)) unlinkSync(p);
    }
  } catch {
    // housekeeping only
  }

  const mod = (await import(pathToFileURL(outfile).href)) as { default: (l: unknown) => unknown };
  return mod.default(letta);
}
