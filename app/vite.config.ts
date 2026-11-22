import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { transform } from "esbuild";
import { buildFrameHtml } from "./src/frame/build.ts";
import { rewriteSharedImports } from "./src/frame/rewrite.ts";

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

async function widgetModule(rel: string): Promise<string | null> {
  if (rel.includes("..") || rel.startsWith("/") || rel.includes("\\") || rel.includes(":") || !rel.endsWith(".js")) return null;
  const stem = rel.slice(0, -3);
  for (const ext of ["tsx", "jsx"] as const) {
    const file = join(widgetsDir, `${stem}.${ext}`);
    if (!existsSync(file)) continue;
    try {
      const out = await transform(readFileSync(file, "utf8"), { loader: ext, jsx: "automatic", format: "esm", target: "es2022", sourcefile: file });
      return rewriteSharedImports(out.code);
    } catch (err) {
      return `throw new Error(${JSON.stringify(`${file}: ${err instanceof Error ? err.message : String(err)}`)});`;
    }
  }
  return null;
}

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
        server.middlewares.use((req, res, next) => {
          const url = new URL(req.url ?? "/", "http://x");
          const send = (type: string, body: string) => {
            res.statusCode = 200;
            res.setHeader("Content-Type", type);
            res.setHeader("Cache-Control", "no-store");
            res.end(body);
          };
          if (url.pathname === "/widget-frame.html") {
            buildFrameHtml(false).then((html) => send("text/html; charset=utf-8", html), next);
            return;
          }
          if (url.pathname.startsWith("/@loki-widget/")) {
            let rel: string;
            try {
              rel = decodeURIComponent(url.pathname.slice("/@loki-widget/".length));
            } catch {
              rel = "";
            }
            widgetModule(rel).then((js) => {
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
