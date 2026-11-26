import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { buildFrameHtml } from "./src/frame/build.ts";
import { widgetModule } from "./src/frame/widget-module.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const modPort = process.env.LOKI_PORT ?? "41414";
const KIT_IMPORT_FOR_AUTHORED_WIDGETS = "@loki/kit";
const { version, repository } = JSON.parse(readFileSync(here("../package.json"), "utf8")) as { version: string; repository?: string };
const repo = (repository ?? "")
  .replace(/^github:/, "")
  .replace(/^https?:\/\/github\.com\//, "")
  .replace(/\.git$/, "");
const widgetsDir = process.env.LOKI_WIDGETS_DIR ?? join(homedir(), ".loki", "widgets");
mkdirSync(widgetsDir, { recursive: true });

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
  plugins: [
    {
      name: "loki:desks",
      enforce: "pre",
      transform(code, id) {
        // Outside (Tailwind): it resolves @source relative to the stylesheet, and Vite's module id may carry a query
        // (?direct, ?used).
        if (id.includes("/src/styles.css")) {
          return code.replaceAll("__LOKI_WIDGETS_DIR__", relative(dirname(id.split("?")[0]), widgetsDir));
        }
      },
      configureServer(server) {
        server.watcher.add(widgetsDir);
      },
    },
    {
      name: "loki:widget-frame",
      configureServer(server) {
        let cachedFrameHtml: Promise<string> | null = null;
        server.watcher.on("change", (file) => {
          const norm = file.replace(/\\/g, "/");
          if (norm.includes("/src/frame/") || norm.includes("/src/kit/")) cachedFrameHtml = null;
        });
        server.middlewares.use((req, res, next) => {
          const url = new URL(req.url ?? "/", "http://x");
          const send = (type: string, body: string) => {
            res.statusCode = 200;
            res.setHeader("Content-Type", type);
            res.setHeader("Cache-Control", "no-store");
            res.end(body);
          };
          if (url.pathname === "/widget-frame.html") {
            cachedFrameHtml ??= buildFrameHtml(false).catch((err: unknown) => {
              cachedFrameHtml = null;
              throw err;
            });
            cachedFrameHtml.then((html) => send("text/html; charset=utf-8", html), next);
            return;
          }
          if (url.pathname.startsWith("/@loki-widget/")) {
            let rel: string;
            try {
              rel = decodeURIComponent(url.pathname.slice("/@loki-widget/".length));
            } catch {
              rel = "";
            }
            widgetModule(widgetsDir, rel).then((js) => {
              if (js === null) {
                res.statusCode = 404;
                res.end("not a widget");
              } else send("text/javascript; charset=utf-8", js);
            }, next);
            return;
          }
          next();
        });
      },
      async generateBundle() {
        this.emitFile({ type: "asset", fileName: "widget-frame.html", source: await buildFrameHtml(true) });
      },
    },
    react({ babel: { plugins: [["babel-plugin-react-compiler", compilerOptions()]] } }),
    tailwindcss(),
  ],
  clearScreen: false,
  define: { __LOKI_VERSION__: JSON.stringify(version), __LOKI_REPO__: JSON.stringify(repo) },
  resolve: {
    alias: { [KIT_IMPORT_FOR_AUTHORED_WIDGETS]: here("./src/kit/index.tsx"), "@": here("./src") },
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
