import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

export const DESKTOP_OUT = "desktop/dist";

export async function buildDesktop(): Promise<void> {
  await build({
    absWorkingDir: root,
    entryPoints: { main: "desktop/main.ts", preload: "desktop/preload.ts" },
    outdir: DESKTOP_OUT,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    minify: true,
    keepNames: true,
    sourcemap: "linked",
    logLevel: "warning",
  });
}

export function stageApp(): void {
  const out = join(root, DESKTOP_OUT);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string; description: string; license: string };
  writeFileSync(
    join(out, "package.json"),
    `${JSON.stringify({ name: "loki", productName: "loki", version: pkg.version, description: pkg.description, license: pkg.license, main: "main.cjs" }, null, 2)}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildDesktop();
  if (process.argv.includes("--stage")) stageApp();
}
