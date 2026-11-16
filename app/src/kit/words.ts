import { Children, type ReactNode } from "react";

export function capitalFirst(text: string): string {
  if (!text || /^loki\b/.test(text)) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function capitalChildren(children: ReactNode): ReactNode {
  if (typeof children === "string") return capitalFirst(children);
  const parts = Children.toArray(children);
  if (parts.length > 1 && typeof parts[0] === "string") return [capitalFirst(parts[0]), ...parts.slice(1)];
  return children;
}
