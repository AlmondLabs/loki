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

/**
 * The canvas dev server. The loki mod adopts or spawns it and passes its own
 * port as LOKI_PORT; the app reaches the mod through the /loki proxy so the
 * page has a single origin.
 */
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const modPort = process.env.LOKI_PORT ?? "41414";
const { version, repository } = JSON.parse(readFileSync(here("../package.json"), "utf8")) as { version: string; repository?: string };
/** "owner/name": what the app asks GitHub about for newer releases (Settings › loki). */
const repo = (repository ?? "").replace(/^github:/, "").replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
/** The agent's widget files: user data outside the repo (the mod passes the same path). */
const widgetsDir = process.env.LOKI_WIDGETS_DIR ?? join(homedir(), ".loki", "widgets");
mkdirSync(widgetsDir, { recursive: true });

/**
 * `/@loki-widget/<desk>/<name>.js` in the dev server: the Vite tab's twin of src-tauri/src/widgets.rs. The
 * widget's .tsx/.jsx, transpiled and with its shared imports pointed at the widget frame's copies. Same-origin
 * only (no CORS header): the page fetches it and hands the code to the widget's sandboxed frame.
 */
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
      // A compile error becomes a module that throws, so the frame shows it like a runtime error (as widgets.rs does).
      return `throw new Error(${JSON.stringify(`${file}: ${err instanceof Error ? err.message : String(err)}`)});`;
    }
  }
  return null;
}

function compilerOptions() {
  const base = {
    // The compiler skips any function carrying an eslint suppression for these rules. This repo runs no
    // ESLint; its `exhaustive-deps` suppressions mark effects that deliberately run on a tick or a key, which
    // the compiler handles as written (deps arrays are kept verbatim). Only rules-of-hooks still opts out.
    eslintSuppressionRules: ["react-hooks/rules-of-hooks"],
  };
  if (!process.env.LOKI_COMPILER_LOG) return base;
  return {
    ...base,
    logger: {
      logEvent(filename: string, event: { kind: string; fnLoc?: { start?: { line: number } } | null; detail?: { reason?: string; description?: string | null } | { options?: { reason?: string } } }) {
        if (event.kind !== "CompileError") return;
        const d = event.detail as { reason?: string; description?: string | null; options?: { reason?: string; description?: string | null } } | undefined;
        const reason = d?.reason ?? d?.options?.reason ?? "";
        const description = d?.description ?? d?.options?.description ?? "";
        console.error(`react-compiler skipped ${relative(here(".."), filename)}:${event.fnLoc?.start?.line ?? "?"} — ${reason}${description ? ` (${description})` : ""}`);
      },
    },
  };
}

export default defineConfig({
  root: here("."),
  // The Tauri shell loads the built app from here (frontendDist in src-tauri/tauri.conf.json).
  build: {
    outDir: here("dist"),
    emptyOutDir: true,
  },
  plugins: [
    {
      // Tailwind must scan the widgets dir for utilities, and Vite must hear about new files there.
      name: "loki:desks",
      enforce: "pre",
      transform(code, id) {
        // Tailwind resolves @source relative to the stylesheet, so hand it a relative path.
        // The id may carry a query (?direct, ?used), so match with includes, not endsWith.
        if (id.includes("/src/styles.css")) {
          return code.replaceAll("__LOKI_WIDGETS_DIR__", relative(dirname(id.split("?")[0]), widgetsDir));
        }
      },
      configureServer(server) {
        server.watcher.add(widgetsDir);
      },
    },
    {
      // The widget frame (app/src/frame/build.ts) and the widget modules it runs: served in dev, emitted in a build.
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
    // React Compiler: callbacks, JSX and derived values are memoised at build time, so a prop that is a fresh
    // closure on every render no longer defeats a memo further down (the transcript once re-parsed a whole
    // thread's markdown per keystroke that way). LOKI_COMPILER_LOG=1 lists what it declined to compile and why.
    react({ babel: { plugins: [["babel-plugin-react-compiler", compilerOptions()]] } }),
    tailwindcss(),
  ],
  clearScreen: false,
  define: { __LOKI_VERSION__: JSON.stringify(version), __LOKI_REPO__: JSON.stringify(repo) },
  resolve: {
    // Authored widgets import the kit by this name; keep it stable in docs.
    alias: { "@loki/kit": here("./src/kit/index.tsx") },
  },
  server: {
    // Not the widgets folder: widget code reaches the page only through /@loki-widget/, into a sandboxed frame.
    fs: { allow: [here("..")] },
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // A broken widget file must not take the whole desk down: errors show inside
    // the widget's frame and reach the agent; Vite's full-page overlay stays off.
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
