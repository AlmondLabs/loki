import { useState } from "react";

/**
 * The agent's face: its profile.png from the memory filesystem, served by the mod. Falls back to a
 * coloured initial when there is no image (or the mod is away), so the layout never jumps.
 */
export function AgentFace({ name, src, size = 20 }: { name: string | null | undefined; src: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  const hue = agentHue(name ?? "agent");
  const style: React.CSSProperties = { width: size, height: size, borderRadius: "50%", flex: "0 0 auto", objectFit: "cover", background: `hsl(${hue} 45% 22%)`, border: `1px solid hsl(${hue} 50% 40% / 0.6)`, boxSizing: "border-box" };
  if (!src || broken) {
    return (
      <span aria-hidden style={{ ...style, display: "inline-grid", placeItems: "center", color: `hsl(${hue} 60% 78%)`, fontFamily: "var(--loki-display)", fontSize: Math.max(9, Math.round(size * 0.5)), lineHeight: 1 }}>
        {(name ?? "?").slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return <img src={src} alt={name ? `${name}'s face` : "agent"} style={style} onError={() => setBroken(true)} />;
}

/** Small tag naming the agent that owns a conversation; colour is stable per name. */
export function agentHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function AgentChip({ name, size = 10.5 }: { name: string | null | undefined; size?: number }) {
  if (!name) return null;
  const hue = agentHue(name);
  return (
    <span
      title={`agent: ${name}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: size,
        letterSpacing: "0.06em",
        padding: "1px 8px",
        borderRadius: 999,
        color: `hsl(${hue} 60% 78%)`,
        background: `hsl(${hue} 45% 22% / 0.55)`,
        border: `1px solid hsl(${hue} 50% 40% / 0.6)`,
        fontFamily: "var(--loki-mono)",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 3, background: `hsl(${hue} 70% 60%)` }} />
      {name}
    </span>
  );
}
