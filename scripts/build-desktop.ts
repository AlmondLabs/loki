import { build } from "esbuild";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    external: ["electron", "esbuild"],
    minify: true,
    keepNames: true,
    sourcemap: "linked",
    logLevel: "warning",
  });
}

export function stageApp(): void {
  const out = join(root, DESKTOP_OUT);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string; description: string; license: string };
  const esbuild = JSON.parse(readFileSync(join(root, "node_modules", "esbuild", "package.json"), "utf8")) as { version: string };
  writeFileSync(
    join(out, "package.json"),
    `${JSON.stringify({ name: "loki", productName: "loki", version: pkg.version, description: pkg.description, license: pkg.license, main: "main.cjs", dependencies: { esbuild: esbuild.version } }, null, 2)}\n`,
  );
  const modules = join(out, "node_modules");
  rmSync(modules, { recursive: true, force: true });
  cpSync(join(root, "node_modules", "esbuild"), join(modules, "esbuild"), { recursive: true, dereference: true });
  const binary = `${process.platform}-${process.arch}`;
  const native = join(root, "node_modules", "@esbuild", binary);
  if (!existsSync(native)) throw new Error(`build:desktop: @esbuild/${binary} is not installed; run the install again`);
  cpSync(native, join(modules, "@esbuild", binary), { recursive: true, dereference: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildDesktop();
  if (process.argv.includes("--stage")) stageApp();
}
