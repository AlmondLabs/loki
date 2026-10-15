import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import type { Gesture, WidgetManifestEntry } from "../../../core/desk-core.ts";
import { WIDGET_MAX_WIDTH, getPath, mergeData } from "../../../core/desk-core.ts";
import { inTauri, openExternal, platform } from "./env";
import { BRIDGE, FRAME_PATH, WIDGET_SANDBOX, readFrameMessage, widgetSource, type ToFrame } from "./widgetBridge";

/**
 * Mounts an agent-authored module from ~/.loki/widgets/<desk>/<name>.tsx in a sandboxed iframe
 * (`allow-scripts` only: an opaque origin). Agent-written code never runs in the page: there it could read the
 * daemon token and approve its own commands. The frame (app/src/frame/) has its own React and kit; this side
 * hands it the module, the data overlay, the page's styles and theme, and reads back only what widgetBridge.ts
 * lets through. A new hash reloads the module in place; load and render errors show here and go back to the mod
 * so desk_state (and the next turn) can report them.
 */

/** The frame body's padding and border, inside WidgetFrame's reading width. */
const CHROME = 26;
/** A frame that has not said it started by now never will (its script was blocked, say). */
const BOOT_TIMEOUT_MS = 10_000;
/** At most one link opened per this long: a widget cannot flood the browser. */
const OPEN_EVERY_MS = 1500;

/** The page's stylesheets as text, for the frame: the tokens, the kit's classes and Tailwind's utilities. */
function pageCss(): string {
  let out = "";
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) out += `${rule.cssText}\n`;
    } catch {
      // a sheet from another origin: not ours to copy
    }
  }
  return out;
}

const themeOf = () => {
  const d = document.documentElement.dataset;
  return { theme: d.theme ?? "dark", palette: d.palette ?? "loki" };
};

export function ModuleWidget({
  entry,
  overlay,
  gesture,
  onError,
  fill = false,
}: {
  entry: WidgetManifestEntry;
  overlay: Record<string, unknown> | undefined;
  gesture: (g: Gesture) => void;
  onError: (id: string, message: string | null) => void;
  /** Fill the width it is given (a frame the human sized, a card in the thread) rather than size to the content. */
  fill?: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  /** Bumped each time the frame (re)starts, so everything it needs is sent again. */
  const [boot, setBoot] = useState(0);
  const [loaded, setLoaded] = useState<{ hash: string; data: Record<string, unknown> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  // The latest of everything the message handler reads, without re-subscribing on each render.
  const live = useRef({ entry, overlay, gesture, onError, moduleData: loaded?.data ?? {}, lastOpen: 0 });
  useEffect(() => {
    live.current = { ...live.current, entry, overlay, gesture, onError, moduleData: loaded?.data ?? {} };
  });

  const send = (msg: { type: ToFrame["type"] } & Record<string, unknown>) => {
    // The frame's origin is opaque ("null"), which postMessage cannot name: "*". Nothing sent here is secret.
    frameRef.current?.contentWindow?.postMessage({ bridge: BRIDGE, ...msg }, "*");
  };

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = readFrameMessage(e, frameRef.current?.contentWindow);
      if (!m) return;
      const { entry, gesture, onError } = live.current;
      switch (m.type) {
        case "ready":
          setBoot((b) => b + 1);
          return;
        case "loaded":
          if (m.hash !== entry.hash) return;
          setLoaded({ hash: m.hash, data: m.data });
          setError(null);
          onError(entry.id, null);
          if (inTauri) console.info(`widget loaded: ${entry.id}`);
          return;
        case "error":
          // "boot": the frame itself failed to start (app/src/frame/build.ts, BOOT_REPORTER), whatever module it was to run
          if (m.hash !== entry.hash && m.hash !== "boot") return;
          setError(m.message);
          onError(entry.id, m.message);
          return;
        case "set": {
          const data = mergeData(live.current.moduleData, live.current.overlay);
          gesture({ kind: "set", id: entry.id, path: m.path, value: m.value, prev: getPath(data, m.path) });
          return;
        }
        case "size":
          setSize((s) => (s && s.width === m.width && s.height === m.height ? s : { width: m.width, height: m.height }));
          return;
        case "focus":
          gesture({ kind: "focus", id: entry.id });
          return;
        case "open": {
          const now = Date.now();
          if (now - live.current.lastOpen < OPEN_EVERY_MS) return;
          live.current.lastOpen = now;
          openExternal(m.url);
          return;
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // A frame that never starts says so, rather than "loading…" for ever.
  useEffect(() => {
    if (boot > 0) return;
    const t = setTimeout(() => {
      const msg = "widget frame did not start";
      setError(msg);
      live.current.onError(live.current.entry.id, msg);
    }, BOOT_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [boot]);

  // Styles and theme: once per start, and again whenever the page's theme changes.
  useEffect(() => {
    if (!boot) return;
    send({ type: "style", css: pageCss(), ...themeOf() });
    const mo = new MutationObserver(() => send({ type: "style", css: pageCss(), ...themeOf() }));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-palette"] });
    return () => mo.disconnect();
  }, [boot]);

  useEffect(() => {
    if (boot) send({ type: "layout", fill, maxWidth: WIDGET_MAX_WIDTH - CHROME });
  }, [boot, fill]);

  // The module: on start and on every new hash (the agent rewrote the file).
  useEffect(() => {
    if (!boot) return;
    let alive = true;
    const fail = (msg: string) => {
      if (!alive) return;
      setError(msg);
      live.current.onError(entry.id, msg);
    };
    const source = widgetSource(entry.file, entry.hash, { tauri: inTauri, os: platform, dev: import.meta.env.DEV });
    if (!source) fail("custom widgets run in the loki app");
    else if ("url" in source) send({ type: "load", hash: entry.hash, url: source.url });
    else {
      fetch(source.fetch)
        .then(async (r) => {
          if (!r.ok) throw new Error(`${entry.file}: ${r.status} ${await r.text()}`);
          return r.text();
        })
        .then((code) => alive && send({ type: "load", hash: entry.hash, code }))
        .catch((err) => fail(err instanceof Error ? err.message : String(err)));
    }
    return () => {
      alive = false;
    };
  }, [boot, entry.file, entry.hash]);

  useEffect(() => {
    if (boot) send({ type: "data", overlay: overlay ?? null });
  }, [boot, overlay]);

  const current = loaded?.hash === entry.hash;
  const shown = error ?? (entry.error && !current ? entry.error : null);
  const visible = !shown && !!loaded;
  return (
    <>
      {shown && <WidgetError message={shown} />}
      {!shown && !loaded && (
        <div className="loki-muted" style={{ fontSize: 12 }}>
          loading…
        </div>
      )}
      <iframe
        ref={frameRef}
        src={FRAME_PATH}
        sandbox={WIDGET_SANDBOX}
        title={entry.title}
        referrerPolicy="no-referrer"
        data-widget-frame={entry.id}
        style={{
          display: "block",
          border: 0,
          background: "transparent",
          width: fill ? "100%" : (size?.width ?? 0),
          maxWidth: "100%",
          height: visible ? (size?.height ?? 0) : 0,
          visibility: visible ? "visible" : "hidden",
        }}
      />
    </>
  );
}

export function WidgetError({ message }: { message: string }) {
  return (
    <div className="loki-meta loki-meta--negative loki-meta--wrap" style={{ fontFamily: "var(--loki-mono)", whiteSpace: "pre-wrap" }}>
      {message}
    </div>
  );
}

export class WidgetErrorBoundary extends Component<
  { id: string; onError: (id: string, message: string | null) => void; children: ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };

  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  componentDidCatch(err: unknown) {
    this.props.onError(this.props.id, err instanceof Error ? err.message : String(err));
  }

  render() {
    if (this.state.error) return <WidgetError message={this.state.error} />;
    return this.props.children;
  }
}
