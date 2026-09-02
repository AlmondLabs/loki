import { WidgetFrame } from "./WidgetFrame";
import { useDesk } from "./useDesk";

/** Renders a widget body by kit type. Grows into the real kit in U5. */
function WidgetBody({ type, data }: { type: string; data: unknown }) {
  if (type === "info-card") {
    const lines = (data as { lines?: string[] })?.lines ?? [];
    return (
      <div style={{ display: "grid", gap: 6 }}>
        {lines.map((line, i) => (
          <div key={i} style={{ fontSize: 13, color: "var(--loci-fg)" }}>
            {line}
          </div>
        ))}
      </div>
    );
  }
  return <div style={{ fontSize: 12, color: "var(--loci-muted)" }}>unknown widget: {type}</div>;
}

export function Surface() {
  const { state, connection, patch } = useDesk();
  const widgets = Object.values(state.widgets);

  return (
    <div
      style={{
        position: "relative",
        height: "100%",
        overflow: "hidden",
        opacity: connection === "open" ? 1 : 0.55,
        transition: "opacity 200ms",
      }}
    >
      {widgets.map((w) => (
        <WidgetFrame key={w.id} widget={w} patch={patch}>
          <WidgetBody type={w.type} data={w.data} />
        </WidgetFrame>
      ))}
      {connection !== "open" && (
        <div
          style={{
            position: "absolute",
            bottom: 16,
            left: 16,
            fontSize: 12,
            color: "var(--loci-muted)",
            letterSpacing: "0.06em",
          }}
        >
          {connection === "connecting" ? "connecting…" : "disconnected — retrying"}
        </div>
      )}
      {widgets.length === 0 && connection === "open" && (
        <div
          style={{
            height: "100%",
            display: "grid",
            placeItems: "center",
            color: "var(--loci-muted)",
            fontSize: 13,
          }}
        >
          empty desk — ask Ira to put something here
        </div>
      )}
    </div>
  );
}
