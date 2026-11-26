import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import type { Gesture, WidgetManifestEntry } from "../../../core/desk-core.ts";
import { WIDGET_MAX_WIDTH, getPath, mergeData } from "../../../core/desk-core.ts";
import { inDesktop, openExternal } from "./env";
import { BRIDGE, FRAME_PATH, WIDGET_SANDBOX, readFrameMessage, widgetSource, type ToFrame } from "./widget-bridge";
import { messageOf } from "../../../core/errors.ts";

const CHROME = 26;
const BOOT_TIMEOUT_MS = 10_000;
const OPEN_EVERY_MS = 1500;

let cachedCss: { count: number; css: string } | null = null;

function pageCss(): string {
  const count = document.styleSheets.length;
  if (cachedCss?.count === count) return cachedCss.css;
  let out = "";
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) out += `${rule.cssText}\n`;
    } catch {}
  }
  cachedCss = { count, css: out };
  return out;
}

const themeOf = () => {
  const d = document.documentElement.dataset;
  return { theme: d.theme ?? "dark" };
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
  fill?: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [boot, setBoot] = useState(0);
  const [loaded, setLoaded] = useState<{ hash: string; data: Record<string, unknown> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  const live = useRef({ entry, overlay, gesture, onError, moduleData: loaded?.data ?? {}, lastOpen: 0 });
  useEffect(() => {
    live.current = { ...live.current, entry, overlay, gesture, onError, moduleData: loaded?.data ?? {} };
  });

  const send = (msg: { type: ToFrame["type"] } & Record<string, unknown>) => {
    // Outside (HTML): a sandboxed frame's origin is opaque ("null"), which postMessage cannot name, so the target is "*".
    // Nothing sent here is secret.
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
          if (inDesktop) console.info(`widget loaded: ${entry.id}`);
          return;
        case "error":
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
          setSize((s) => (s?.width === m.width && s.height === m.height ? s : { width: m.width, height: m.height }));
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

  useEffect(() => {
    if (boot > 0) return;
    const t = setTimeout(() => {
      const msg = "widget frame did not start";
      setError(msg);
      live.current.onError(live.current.entry.id, msg);
    }, BOOT_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [boot]);

  useEffect(() => {
    if (!boot) return;
    send({ type: "style", css: pageCss(), ...themeOf() });
    const mo = new MutationObserver(() => send({ type: "style", css: pageCss(), ...themeOf() }));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, [boot]);

  useEffect(() => {
    if (boot) send({ type: "layout", fill, maxWidth: WIDGET_MAX_WIDTH - CHROME });
  }, [boot, fill]);

  useEffect(() => {
    if (!boot) return;
    let alive = true;
    const fail = (msg: string) => {
      if (!alive) return;
      setError(msg);
      live.current.onError(entry.id, msg);
    };
    const source = widgetSource(entry.file, entry.hash, { desktop: inDesktop, dev: import.meta.env.DEV });
    if (!source) fail("custom widgets run in the loki app");
    else if ("url" in source) send({ type: "load", hash: entry.hash, url: source.url });
    else {
      fetch(source.fetch)
        .then(async (r) => {
          if (!r.ok) throw new Error(`${entry.file}: ${r.status} ${await r.text()}`);
          return r.text();
        })
        .then((code) => alive && send({ type: "load", hash: entry.hash, code }))
        .catch((err: unknown) => fail(messageOf(err)));
    }
    return () => {
      alive = false;
    };
  }, [boot, entry.id, entry.file, entry.hash]);

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
        <div className="loki-muted" style={{ fontSize: "var(--text-xs)" }}>
          Loading…
        </div>
      )}
      <iframe
        ref={frameRef}
        src={FRAME_PATH}
        sandbox={WIDGET_SANDBOX}
        title={entry.title}
        referrerPolicy="no-referrer"
        data-widget-frame={entry.id}
        className="block"
        style={{
          border: 0,
          background: "transparent",
          width: fill ? "100%" : (size?.width ?? 0),
          maxWidth: "100%",
          height: visible ? (size?.height ?? 0) : 0,
          visibility: visible ? "inherit" : "hidden",
        }}
      />
    </>
  );
}

export function WidgetError({ message }: { message: string }) {
  return (
    <div className="loki-meta loki-meta--negative loki-meta--wrap loki-mono" style={{ whiteSpace: "pre-wrap" }}>
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
    return { error: messageOf(err) };
  }

  componentDidCatch(err: unknown) {
    this.props.onError(this.props.id, messageOf(err));
  }

  render() {
    if (this.state.error) return <WidgetError message={this.state.error} />;
    return this.props.children;
  }
}
