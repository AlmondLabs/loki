import { useState } from "react";

/**
 * The agent's face: its profile.png from the memory filesystem, served by the mod. Falls back to a
 * coloured initial when there is no image (or the mod is away), so the layout never jumps.
 */
export function AgentFace({ name, src, size = 20 }: { name: string | null | undefined; src: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  // An agent with no picture is Messages' grey monogram, not a coloured tile (plan 2026-11-12-1505, U17). A picture
  // sits on the input well, so a transparent or still-loading one shows the theme's own ground.
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

/** Liquid Glass's monogram ground: the grey gradient Messages and Contacts draw under an initial, with no ring. */
const MONOGRAM: React.CSSProperties = { background: "linear-gradient(var(--loki-monogram-top), var(--loki-monogram-bottom))", border: 0 };

/** The hue (0 to 359) of an agent's colour, worked out from its name so the same name always gets the same colour. */
export function agentHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** The label hues (`--loki-label-0` … `--loki-label-7` in tokens.css), in order; an agent takes the nearest one. */
const LABEL_HUES = [25, 65, 95, 150, 195, 250, 300, 350];

/** The chat-label colour nearest an agent's hue, as a token, so it holds its contrast in day and night alike. */
export function agentLabel(name: string): string {
  const hue = agentHue(name);
  const gap = (h: number) => Math.min(Math.abs(h - hue), 360 - Math.abs(h - hue));
  const index = LABEL_HUES.reduce((best, h, i) => (gap(h) < gap(LABEL_HUES[best] ?? 0) ? i : best), 0);
  return `var(--loki-label-${index})`;
}

/**
 * A small pill naming the agent that owns a chat; nothing when there is no name. The agent's colour is the dot and a
 * faint wash of it; the name is in the reading ink, so it passes AA on either theme whatever the colour.
 */
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
