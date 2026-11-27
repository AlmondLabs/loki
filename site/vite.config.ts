import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const { version } = JSON.parse(readFileSync(here("../package.json"), "utf8")) as { version: string };

export default defineConfig({
  root: here("."),
  base: "./",
  build: { outDir: here("dist"), emptyOutDir: true, reportCompressedSize: false },
  plugins: [react(), tailwindcss()],
  define: { __LOKI_VERSION__: JSON.stringify(version), __LOKI_REPO__: JSON.stringify("") },
  resolve: { alias: { "@loki/kit": here("../app/src/kit/index.tsx"), "@": here("../app/src") } },
  server: { host: "127.0.0.1", port: 5180, strictPort: true, fs: { allow: [here("..")] } },
});
