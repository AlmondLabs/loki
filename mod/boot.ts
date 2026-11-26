import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

type Activate = (api: unknown, host: unknown) => unknown;

function hasNewer(dir: string, since: number): boolean {
  if (!existsSync(dir)) return false;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".loki-build") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (hasNewer(full, since)) return true;
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") || entry.name.endsWith(".mts")) {
      if (statSync(full).mtimeMs > since) return true;
    }
  }
  return false;
}

export async function ensureBuilt({ fresh = false }: { fresh?: boolean } = {}): Promise<string> {
  // Outside (Node): fileURLToPath drops the query on this module's URL.
  const here = fileURLToPath(new URL(import.meta.url));
  const root = dirname(dirname(here));
  const outDir = join(root, ".loki-build");
  mkdirSync(outDir, { recursive: true });
  const devOut = join(outDir, "mod-dev.mjs");
  if (!fresh && existsSync(devOut)) {
    const builtAt = statSync(devOut).mtimeMs;
    const stale = ["mod", "core", "daemon"].some((d) => hasNewer(join(root, d), builtAt)) || statSync(join(root, "package.json")).mtimeMs > builtAt;
    if (!stale) return devOut;
  }
  const outfile = fresh ? join(outDir, `mod-${Date.now()}.mjs`) : devOut;

  await esbuild.build({
    entryPoints: [join(root, "mod", "index.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
    sourcemap: false,
    logLevel: "silent",
  });

  try {
    for (const f of readdirSync(outDir)) {
      const p = join(outDir, f);
      if (p !== outfile && f.startsWith("mod-") && existsSync(p)) unlinkSync(p);
    }
  } catch {}

  return outfile;
}

/**
 * The mod's entry in a checkout, which the daemon loads in development (desktop/daemon.ts daemonEntries). Node
 * caches ES modules by URL for the life of the process, so re-importing mod/index.ts would refresh only that file —
 * every file it imports would still be the old copy. Bundling the mod's own files into a uniquely named file on each
 * reload gives a reload a genuinely fresh module graph. node_modules stay external and resolve from the project
 * because the bundle is written inside it. The daemon calls `build` before it stops the mod that is running, so source
 * that does not build never replaces it; the default export is for a host that only knows how to activate.
 */
export async function build(opts?: { fresh?: boolean }): Promise<Activate> {
  const outfile = await ensureBuilt(opts);
  const mod = (await import(pathToFileURL(outfile).href)) as { default: Activate };
  return mod.default;
}

export default async function activate(api: unknown, host: unknown): Promise<unknown> {
  return (await build())(api, host);
}
