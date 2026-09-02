import { Component, useEffect, useState, type ComponentType, type ReactNode } from "react";
import type { KitProps } from "../kit";

/**
 * Loads a runtime-authored widget module (/widgets/<id>.js) and mounts its
 * default export inside an error boundary. Bundle errors are already reported
 * by loci_author; this handles runtime (render) errors — shown in-frame and
 * reported to the mod via onError so loci_state can surface them.
 */
export function ModuleHost({
  id,
  moduleRev,
  data,
  onSet,
  onError,
}: {
  id: string;
  moduleRev: number;
  data: Record<string, unknown>;
  onSet: (path: string, value: unknown) => void;
  onError: (id: string, message: string | null) => void;
}) {
  const [Comp, setComp] = useState<ComponentType<KitProps> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setComp(null);
    setLoadError(null);
    // moduleRev busts the browser's module cache on re-author.
    import(/* @vite-ignore */ `/widgets/${id}.js?v=${moduleRev}`)
      .then((mod) => {
        if (!alive) return;
        const C = mod.default as ComponentType<KitProps> | undefined;
        if (typeof C !== "function") {
          setLoadError("module has no default-exported component");
          onError(id, "module has no default-exported component");
        } else {
          setComp(() => C);
        }
      })
      .catch((err) => {
        if (!alive) return;
        const msg = err instanceof Error ? err.message : String(err);
        setLoadError(msg);
        onError(id, msg);
      });
    return () => {
      alive = false;
    };
  }, [id, moduleRev, onError]);

  if (loadError) return <WidgetError message={loadError} />;
  if (!Comp) return <div className="loci-muted" style={{ fontSize: 12 }}>loading…</div>;

  return (
    <WidgetErrorBoundary id={id} onError={onError}>
      <Comp data={data} onSet={onSet} />
    </WidgetErrorBoundary>
  );
}

function WidgetError({ message }: { message: string }) {
  return (
    <div style={{ fontSize: 12, color: "var(--loci-negative)", fontFamily: "var(--loci-mono)", whiteSpace: "pre-wrap" }}>
      widget error: {message}
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

  componentDidUpdate(_: unknown, prev: { error: string | null }) {
    if (prev.error && !this.state.error) this.props.onError(this.props.id, null);
  }

  render() {
    if (this.state.error) return <WidgetError message={this.state.error} />;
    return this.props.children;
  }
}
