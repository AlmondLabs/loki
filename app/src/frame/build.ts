import { build } from "esbuild";
import { fileURLToPath } from "node:url";

/**
 * widget-frame.html: the document a module widget's sandboxed iframe loads (app/src/desk/widgetBridge.ts).
 * The runtime (main.tsx, with its own React, ReactDOM, recharts and kit) is bundled into one classic script and
 * inlined: a sandboxed frame has an opaque origin, so a module script or a stylesheet fetched from the app's
 * own server would be a cross-origin request the server does not answer. The Tauri shell hashes inline
 * scripts into the CSP it serves with each HTML asset, so the inline script runs there too.
 *
 * The frame's own policy (the meta tag) is the narrow one: no fetch, XHR, WebSocket or EventSource at all
 * (connect-src 'none'), so even code that somehow came by the daemon token could not reach the daemon; scripts
 * only inline, from the shell's `loki` scheme (both spellings) and from blob: (the Vite tab hands the frame
 * the widget's code); no frames, workers, forms or plugins. In the shell the app's CSP applies on top.
 */
export const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' loki: http://loki.localhost blob:",
  "style-src 'unsafe-inline'",
  "img-src data: blob: https:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** Bundle the frame runtime. `production` minifies and selects React's production build. */
export async function buildFrameScript(production: boolean): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./main.tsx", import.meta.url))],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    minify: production,
    legalComments: "none",
    // Styles come from the page (it posts its stylesheets in), never from the bundle.
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") },
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

/**
 * Runs before the runtime: an error that stops the frame from starting reaches the page as the widget's error
 * (hash "boot"), instead of a frame that never says it is ready. Removed once the runtime has started.
 */
export const BOOT_REPORTER = `(function(){function r(m){try{parent.postMessage({bridge:"loki-widget",type:"error",hash:"boot",message:"widget frame: "+String(m)},"*")}catch(_){}}window.__lokiBootError=function(e){r(e&&e.message||e)};window.addEventListener("error",window.__lokiBootError);window.addEventListener("unhandledrejection",function(e){r(e.reason&&e.reason.message||e.reason)})})();`;

/** The frame document around a bundled runtime. */
export function frameHtml(script: string): string {
  // esbuild escapes "</script" inside strings and regexes; any that is left would end the tag early.
  if (/<\/script/i.test(script)) throw new Error("widget frame bundle contains </script");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<style id="loki-page-css"></style>
<style>
html, body { margin: 0; padding: 0; height: auto !important; min-height: 0 !important; background: transparent !important; }
body { overflow-x: auto; overflow-y: hidden; }
#root { height: auto !important; background: transparent !important; }
</style>
</head>
<body><div id="root"></div><script>${BOOT_REPORTER}</script><script>${script}</script></body>
</html>
`;
}

export async function buildFrameHtml(production: boolean): Promise<string> {
  return frameHtml(await buildFrameScript(production));
}
