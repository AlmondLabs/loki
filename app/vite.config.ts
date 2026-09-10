import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

/**
 * The canvas dev server. The loki mod adopts or spawns it and passes its own
 * port as LOKI_PORT; the app reaches the mod through the /loki proxy so the
 * page has a single origin.
 */
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const modPort = process.env.LOKI_PORT ?? "41414";
const { version } = JSON.parse(readFileSync(here("../package.json"), "utf8")) as { version: string };
/** The agent's widget files: user data outside the repo (the mod passes the same path). */
const widgetsDir = process.env.LOKI_WIDGETS_DIR ?? join(homedir(), ".letta", "loki", "widgets");
mkdirSync(widgetsDir, { recursive: true });

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
    // The agent's widget files are dev-time HMR targets only; a production build must not pull them in.
    rollupOptions: { external: (id) => id.startsWith(widgetsDir) },
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
    // React Compiler: callbacks, JSX and derived values are memoised at build time, so a prop that is a fresh
    // closure on every render no longer defeats a memo further down (the transcript once re-parsed a whole
    // thread's markdown per keystroke that way). LOKI_COMPILER_LOG=1 lists what it declined to compile and why.
    react({ babel: { plugins: [["babel-plugin-react-compiler", compilerOptions()]] } }),
    tailwindcss(),
  ],
  clearScreen: false,
  define: { __LOKI_WIDGETS_DIR__: JSON.stringify(widgetsDir), __LOKI_VERSION__: JSON.stringify(version) },
  resolve: {
    // Authored widgets import the kit by this name; keep it stable in docs.
    alias: { "@loki/kit": here("./src/kit/index.tsx"), "@desks": widgetsDir },
  },
  server: {
    fs: { allow: [here(".."), widgetsDir] },
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
