import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { relative } from "node:path";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const modPort = process.env.LOKI_PORT ?? "41414";
const { version, repository } = JSON.parse(readFileSync(here("../package.json"), "utf8")) as { version: string; repository?: string };
const repo = (repository ?? "")
  .replace(/^github:/, "")
  .replace(/^https?:\/\/github\.com\//, "")
  .replace(/\.git$/, "");

function compilerOptions() {
  const base = {
    // Outside (React Compiler): it skips every function that suppresses a rule listed here, and compiles an
    // `exhaustive-deps` suppression with its deps array as written, so only rules-of-hooks is listed.
    eslintSuppressionRules: ["react-hooks/rules-of-hooks"],
  };
  if (!process.env.LOKI_COMPILER_LOG) return base;
  return {
    ...base,
    logger: {
      logEvent(
        filename: string,
        event: {
          kind: string;
          fnLoc?: { start?: { line: number } } | null;
          detail?: { reason?: string; description?: string | null; options?: { reason?: string; description?: string | null } };
        },
      ) {
        if (event.kind !== "CompileError") return;
        const d = event.detail;
        const reason = d?.reason ?? d?.options?.reason ?? "";
        const description = d?.description ?? d?.options?.description ?? "";
        console.error(
          `react-compiler skipped ${relative(here(".."), filename)}:${event.fnLoc?.start?.line ?? "?"} — ${reason}${description ? ` (${description})` : ""}`,
        );
      },
    },
  };
}

export default defineConfig({
  root: here("."),
  build: {
    outDir: here("dist"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (/\/node_modules\/(?:react|react-dom|scheduler)\//.test(id)) return "react";
          if (/\/node_modules\/(?:react-markdown|remark-|micromark|mdast-|unist-|hast-|vfile)/.test(id)) return "markdown";
          if (id.includes("/node_modules/lucide-react/")) return "icons";
        },
      },
    },
  },
  plugins: [react({ babel: { plugins: [["babel-plugin-react-compiler", compilerOptions()]] } }), tailwindcss()],
  clearScreen: false,
  define: { __LOKI_VERSION__: JSON.stringify(version), __LOKI_REPO__: JSON.stringify(repo) },
  resolve: {
    alias: { "@": here("./src") },
  },
  server: {
    fs: { allow: [here("..")] },
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    hmr: { overlay: false },
    proxy: {
      "/loki": {
        target: `http://127.0.0.1:${modPort}`,
        ws: true,
        rewrite: (p) => p.replace(/^\/loki/, ""),
      },
    },
  },
});
