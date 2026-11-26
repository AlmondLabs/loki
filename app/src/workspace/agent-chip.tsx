import { useState } from "react";

export function AgentFace({ name, src, size = 20 }: { name: string | null | undefined; src: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  const style: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    flex: "0 0 auto",
    objectFit: "cover",
    background: "var(--loki-well)",
    border: "1px solid var(--loki-border)",
    boxSizing: "border-box",
  };
  if (!src || broken) {
    return (
      <span
        aria-hidden
        data-monogram
        style={{
          ...style,
          ...MONOGRAM,
          display: "inline-grid",
          placeItems: "center",
          color: "var(--loki-on-monogram)",
          fontWeight: 700,
          fontSize: Math.max(9, Math.round(size * 0.5)),
          lineHeight: 1,
        }}
      >
        {(name ?? "?").slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return <img src={src} alt={name ? `${name}'s face` : "agent"} style={style} onError={() => setBroken(true)} />;
}

const MONOGRAM: React.CSSProperties = { background: "linear-gradient(var(--loki-monogram-top), var(--loki-monogram-bottom))", border: 0 };

export function agentHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

const LABEL_HUES = [25, 65, 95, 150, 195, 250, 300, 350];

export function agentLabel(name: string): string {
  const hue = agentHue(name);
  const gap = (h: number) => Math.min(Math.abs(h - hue), 360 - Math.abs(h - hue));
  const index = LABEL_HUES.reduce((best, h, i) => (gap(h) < gap(LABEL_HUES[best] ?? 0) ? i : best), 0);
  return `var(--loki-label-${index})`;
}

export function AgentChip({ name, size = "var(--text-xs)" }: { name: string | null | undefined; size?: string }) {
  if (!name) return null;
  const label = agentLabel(name);
  return (
    <span
      title={`Agent: ${name}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: size,
        fontWeight: 600,
        padding: "1px 8px",
        borderRadius: "var(--loki-radius-pill)",
        color: "var(--loki-fg)",
        background: `color-mix(in oklab, ${label} 14%, transparent)`,
        border: `1px solid color-mix(in oklab, ${label} 40%, transparent)`,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "var(--loki-radius-pill)", background: label }} />
      {name}
    </span>
  );
}
