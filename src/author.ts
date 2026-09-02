import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Runtime widget authoring. Writes an authored .tsx to widgets/, bundles it
 * with the project's esbuild binary (react / jsx-runtime / kit kept external —
 * resolved from host globals via the import map), and returns the bundled ESM
 * path or the esbuild error text. esbuild is a native binary, so it is spawned,
 * never imported into the mod bundle.
 */

export interface AuthorResult {
  ok: boolean;
  /** Server-relative URL of the bundled module when ok. */
  url?: string;
  /** esbuild stderr when !ok. */
  error?: string;
}

const EXTERNAL = ["react", "react/jsx-runtime", "@loci/kit"];

/** Project root, resolved from the built mod location (dist/mod.js → up one). */
function projectRoot(): string {
  // import.meta.url may carry a cache-busting ?v=… query; strip it.
  const here = fileURLToPath(new URL(import.meta.url));
  return dirname(dirname(here)); // dist/ → project root
}

export function widgetsDir(): string {
  return join(projectRoot(), "widgets");
}

function esbuildBin(): string {
  return join(projectRoot(), "node_modules", ".bin", "esbuild");
}

export async function authorWidget(id: string, source: string): Promise<AuthorResult> {
  const dir = widgetsDir();
  mkdirSync(dir, { recursive: true });
  const srcPath = join(dir, `${id}.tsx`);
  const outPath = join(dir, `${id}.js`);
  writeFileSync(srcPath, source);

  const args = [
    srcPath,
    "--bundle",
    "--format=esm",
    "--jsx=automatic",
    "--target=es2022",
    "--log-level=warning",
    ...EXTERNAL.map((e) => `--external:${e}`),
    `--outfile=${outPath}`,
  ];

  return new Promise<AuthorResult>((resolve) => {
    const proc = spawn(esbuildBin(), args, { cwd: projectRoot() });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += String(d)));
    proc.on("error", (err) =>
      resolve({ ok: false, error: `esbuild spawn failed: ${err.message}` }),
    );
    proc.on("close", (code) => {
      if (code === 0) resolve({ ok: true, url: `/widgets/${id}.js` });
      else resolve({ ok: false, error: stderr.trim() || `esbuild exited ${code}` });
    });
  });
}
