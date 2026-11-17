const query = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

export function prefersReducedMotion(): boolean {
  return !!query?.matches;
}

export function glide(ms: number): number {
  return prefersReducedMotion() ? 0 : ms;
}

let input: "key" | "pointer" = "pointer";
if (typeof window !== "undefined") {
  window.addEventListener("keydown", () => (input = "key"), true);
  window.addEventListener("pointerdown", () => (input = "pointer"), true);
}
export function lastInput(): "key" | "pointer" {
  return input;
}
