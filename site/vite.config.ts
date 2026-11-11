import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

/**
 * loki's website (plan 066): a static page built from the app's own components with made-up data. Relative asset
 * paths (`base: "./"`), so the same build serves at almondlabs.github.io/loki/ and at a domain of its own.
 */
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const { version } = JSON.parse(readFileSync(here("../package.json"), "utf8")) as { version: string };

export default defineConfig({
  root: here("."),
  base: "./",
  build: { outDir: here("dist"), emptyOutDir: true },
  plugins: [react(), tailwindcss()],
  // The app's modules read these at build time; the site has no update check, so the repository is left empty.
  define: { __LOKI_VERSION__: JSON.stringify(version), __LOKI_REPO__: JSON.stringify("") },
  resolve: { alias: { "@loki/kit": here("../app/src/kit/index.tsx"), "@": here("../app/src") } },
  server: { host: "127.0.0.1", port: 5180, strictPort: true, fs: { allow: [here("..")] } },
});
