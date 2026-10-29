import * as React from "react";
import { Component, type ComponentType, type ReactNode } from "react";
import * as ReactDOM from "react-dom";
import { createRoot } from "react-dom/client";
import * as jsxRuntime from "react/jsx-runtime";
import * as recharts from "recharts";
import * as kit from "../kit/index";
import { mergeData } from "../../../core/desk-core.ts";
import { messageOf } from "../../../core/errors.ts";

/**
 * The widget frame: the document inside the sandboxed iframe that runs one agent-written widget
 * (module-widget.tsx). Built by app/src/frame/build.ts into one classic script inlined in widget-frame.html.
 * It has its own React and kit (window.__lokiShared, where a widget's bare imports point), takes the module,
 * the data overlay, the page's styles and the layout mode from the page, and sends back only what
 * app/src/desk/widget-bridge.ts reads: ready, loaded, error, set, size, focus and open.
 */

declare global {
  interface Window {
    __lokiShared?: Record<string, unknown>;
  }
}

const BRIDGE = "loki-widget";
type Out = { type: string } & Record<string, unknown>;
const post = (msg: Out) => {
  try {
    // The page's origin is not ours to know for sure (tauri://localhost, http://tauri.localhost, Vite); nothing sent is secret.
    window.parent.postMessage({ bridge: BRIDGE, ...msg }, "*");
  } catch (err) {
    // A value that cannot be cloned: say so rather than fail silently.
    if (msg.type === "set") console.warn("loki widget: onSet value could not be sent", err);
  }
};

// Nothing the shell may have put on a window belongs here. The sandbox already keeps the page's own globals out;
// these go too in case a webview injects its scripts into every frame.
for (const key of ["__LOKI__", "__TAURI_INTERNALS__", "__TAURI__", "__TAURI_IPC__", "__TAURI_METADATA__", "ipc"]) {
  try {
    Reflect.deleteProperty(window, key);
  } catch {
    // non-configurable: nothing to do
  }
}

Object.defineProperty(window, "__lokiShared", {
  value: Object.freeze({ react: React, "react/jsx-runtime": jsxRuntime, "react-dom": ReactDOM, recharts, "@loki/kit": kit }),
  writable: false,
  configurable: false,
});

interface WidgetProps {
  data: Record<string, unknown>;
  onSet: (path: string, value: unknown) => void;
}
const state: {
  hash: string | null;
  Comp: ComponentType<WidgetProps> | null;
  moduleData: Record<string, unknown>;
  overlay: Record<string, unknown> | null;
  fill: boolean;
  maxWidth: number;
} = { hash: null, Comp: null, moduleData: {}, overlay: null, fill: false, maxWidth: 734 };

const rootEl = ((): HTMLElement => {
  const el = document.getElementById("root");
  if (!el) throw new Error("loki: the widget frame has no #root element");
  return el;
})();
const root = createRoot(rootEl);

class Boundary extends Component<{ hash: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    post({ type: "error", hash: this.props.hash, message: messageOf(err) });
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const onSet = (path: string, value: unknown) => post({ type: "set", path, value });

function render() {
  rootEl.style.width = state.fill ? "100%" : "max-content";
  rootEl.style.maxWidth = state.fill ? "" : `${state.maxWidth}px`;
  const { Comp, hash } = state;
  if (!Comp || !hash) return;
  const data = mergeData(state.moduleData, state.overlay ?? undefined);
  root.render(
    <Boundary key={hash} hash={hash}>
      <Comp data={data} onSet={onSet} />
    </Boundary>,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function load(hash: string, source: { url: string } | { code: string }) {
  state.hash = hash;
  let blob: string | null = null;
  try {
    let mod: Record<string, unknown> | null = null;
    if ("code" in source) {
      blob = URL.createObjectURL(new Blob([source.code], { type: "text/javascript" }));
      mod = (await import(/* @vite-ignore */ blob)) as Record<string, unknown>;
    } else {
      // The page's manifest and the file on disk race by a few hundred ms, and a failed import is cached by URL:
      // retry a few times, each under its own URL.
      for (let attempt = 0; ; attempt++) {
        try {
          mod = (await import(/* @vite-ignore */ attempt ? `${source.url}&r=${attempt}` : source.url)) as Record<string, unknown>;
          break;
        } catch (err) {
          if (attempt >= 3 || state.hash !== hash) throw err;
          await sleep(400);
        }
      }
    }
    if (state.hash !== hash) return; // a newer version arrived meanwhile
    const C = mod.default;
    if (typeof C !== "function") throw new Error("module has no default-exported component");
    const data = typeof mod.data === "object" && mod.data !== null && !Array.isArray(mod.data) ? (mod.data as Record<string, unknown>) : {};
    state.Comp = C as ComponentType<WidgetProps>;
    state.moduleData = data;
    try {
      window.parent.postMessage({ bridge: BRIDGE, type: "loaded", hash, data }, "*");
    } catch {
      post({ type: "loaded", hash, data: {} }); // data the page cannot be sent: the widget still runs on its own copy
    }
    render();
  } catch (err) {
    if (state.hash === hash) post({ type: "error", hash, message: messageOf(err) });
  } finally {
    if (blob) URL.revokeObjectURL(blob);
  }
}

const pageCss = document.getElementById("loki-page-css") as HTMLStyleElement;

window.addEventListener("message", (e) => {
  if (e.source !== window.parent) return;
  const m = e.data as Record<string, unknown> | null;
  if (!m || typeof m !== "object" || m.bridge !== BRIDGE) return;
  switch (m.type) {
    case "load":
      if (typeof m.hash !== "string") return;
      if (typeof m.code === "string") void load(m.hash, { code: m.code });
      else if (typeof m.url === "string") void load(m.hash, { url: m.url });
      return;
    case "data":
      state.overlay = m.overlay && typeof m.overlay === "object" ? (m.overlay as Record<string, unknown>) : null;
      render();
      return;
    case "style": {
      if (typeof m.css === "string") pageCss.textContent = m.css;
      const el = document.documentElement;
      if (typeof m.theme === "string") {
        el.dataset.theme = m.theme;
        el.style.colorScheme = m.theme;
      }
      if (typeof m.palette === "string") el.dataset.palette = m.palette;
      return;
    }
    case "layout":
      state.fill = m.fill === true;
      if (typeof m.maxWidth === "number" && m.maxWidth > 0) state.maxWidth = m.maxWidth;
      render();
      return;
  }
});

// How big the widget is: the page sizes the iframe to it.
let last = { width: -1, height: -1 };
new ResizeObserver(() => {
  const r = rootEl.getBoundingClientRect();
  const size = { width: Math.ceil(Math.max(r.width, rootEl.scrollWidth)), height: Math.ceil(Math.max(r.height, rootEl.scrollHeight)) };
  if (size.width === last.width && size.height === last.height) return;
  last = size;
  post({ type: "size", ...size });
}).observe(rootEl);

// A press inside the widget brings its frame to the front, as a press on the frame does.
window.addEventListener("pointerdown", () => post({ type: "focus" }), true);

// Links go to the browser, never into this frame (the page opens them the way it opens its own).
document.addEventListener(
  "click",
  (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) return;
    e.preventDefault();
    if (/^https?:/i.test(a.href)) post({ type: "open", url: a.href });
  },
  true,
);

post({ type: "ready" });
