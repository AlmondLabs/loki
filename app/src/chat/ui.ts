import type React from "react";

/** The one button style for chat surfaces (desk chat and Catch Up). */
export function btn(color = "var(--loki-muted)"): React.CSSProperties {
  return {
    fontSize: 12.5,
    padding: "7px 12px",
    borderRadius: 8,
    border: "1px solid var(--loki-border)",
    background: "transparent",
    color,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
  };
}

export const kbd: React.CSSProperties = { fontFamily: "var(--loki-mono)", fontSize: 10, opacity: 0.6, marginLeft: 6, border: "1px solid var(--loki-border)", borderRadius: 4, padding: "0 4px" };
