/** Small tag naming the agent that owns a conversation; colour is stable per name. */
export function agentHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function AgentChip({ name, size = 11 }: { name: string | null | undefined; size?: number }) {
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
