import { Component, useEffect, useState, type ComponentType, type ReactNode } from "react";
import type { Gesture, WidgetManifestEntry } from "../../../core/desk-core.ts";
import { getPath, mergeData } from "../../../core/desk-core.ts";
import type { KitProps } from "../kit";

/**
 * Mounts an agent-authored module from app/src/widgets/<desk>/<name>.tsx.
 * Vite's glob knows every widget file; HMR swaps the module when the agent
 * edits it. Runtime errors land in an in-frame boundary and go back to the
 * mod so desk_state (and the next turn) can report them.
 */
declare const __LOKI_WIDGETS_DIR__: string;
import { inTauri } from "./env";
// "@desks" is aliased to the widgets dir in vite.config.ts. Keys come back in whatever form Vite
// resolves them to, so lookups match on the "<desk>/<name>.ext" suffix.
// Dev only: Vite pre-registers the agent's widget files so HMR reaches them. A production build
// must not bundle files from ~/.letta; there widgets arrive compiled from the shell (loki://) instead.
const loaders: Record<string, () => Promise<Record<string, unknown>>> = import.meta.env.DEV ? import.meta.glob<Record<string, unknown>>("@desks/*/*.{tsx,jsx}") : {};
const loaderFor = (file: string) => {
  const suffix = `/${file}`;
  const key = Object.keys(loaders).find((k) => k.endsWith(suffix));
  return key ? loaders[key] : undefined;
};

export function ModuleWidget({
  entry,
  overlay,
  gesture,
  onError,
}: {
  entry: WidgetManifestEntry;
  overlay: Record<string, unknown> | undefined;
  gesture: (g: Gesture) => void;
  onError: (id: string, message: string | null) => void;
}) {
  const [Comp, setComp] = useState<ComponentType<KitProps> | null>(null);
  const [moduleData, setModuleData] = useState<Record<string, unknown>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;

    // The mod's manifest and Vite's HMR race by a few hundred ms. A failed ES import is cached by
    // URL, so after the glob loader rejects we fall back to a hash-busted direct import, and retry.
    const load = async (): Promise<Record<string, unknown>> => {
      const viaGlob = loaderFor(entry.file);
      if (viaGlob) {
        try {
          return await viaGlob();
        } catch {
          // fall through
        }
      }
      // Tauri: the Rust core transpiles the file on request and rewrites its bare imports to the
      // app's shared copies (window.__lokiShared). Browser: Vite serves the file from disk.
      const direct = inTauri
        ? `loki://localhost/widgets/${entry.file.replace(/\.(tsx|jsx)$/, ".js")}?v=${entry.hash}`
        : `/@fs${__LOKI_WIDGETS_DIR__}/${entry.file}?v=${entry.hash}`;
      return (await import(/* @vite-ignore */ direct)) as Record<string, unknown>;
    };

    const tryLoad = () => {
      load()
        .then((mod) => {
          if (!alive) return;
          const C = mod.default as ComponentType<KitProps> | undefined;
          if (typeof C !== "function") {
            const msg = "module has no default-exported component";
            setLoadError(msg);
            onError(entry.id, msg);
            return;
          }
          if (inTauri) console.info(`widget loaded: ${entry.id}`);
          setComp(() => C);
          setModuleData(typeof mod.data === "object" && mod.data !== null ? (mod.data as Record<string, unknown>) : {});
          setLoadError(null);
          onError(entry.id, null);
        })
        .catch((err) => {
          if (!alive) return;
          if (attempt++ < 3) {
            retry = setTimeout(tryLoad, 400);
            return;
          }
          const msg = err instanceof Error ? err.message : String(err);
          setLoadError(msg);
          onError(entry.id, msg);
        });
    };
    tryLoad();
    return () => {
      alive = false;
      if (retry) clearTimeout(retry);
    };
  }, [entry.id, entry.file, entry.hash, onError]);

  if (entry.error && !Comp) return <WidgetError message={entry.error} />;
  if (loadError) return <WidgetError message={loadError} />;
  if (!Comp) return <div className="loki-muted" style={{ fontSize: 12 }}>loading…</div>;

  const data = mergeData(moduleData, overlay);
  const onSet = (path: string, value: unknown) => gesture({ kind: "set", id: entry.id, path, value, prev: getPath(data, path) });
  return (
    <WidgetErrorBoundary key={entry.hash} id={entry.id} onError={onError}>
      <Comp data={data} onSet={onSet} />
    </WidgetErrorBoundary>
  );
}

export function WidgetError({ message }: { message: string }) {
  return (
    <div className="loki-meta loki-meta--negative loki-meta--wrap" style={{ fontFamily: "var(--loki-mono)", whiteSpace: "pre-wrap" }}>
      {message}
    </div>
  );
}

class WidgetErrorBoundary extends Component<
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
