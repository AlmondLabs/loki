/** Render a tool call's input for a human: shell commands as-is, everything else as JSON. */
export function formatInput(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o.command === "string") return o.command + (typeof o.description === "string" ? `\n# ${o.description}` : "");
    try {
      return JSON.stringify(o, null, 2);
    } catch {
      return Object.prototype.toString.call(o);
    }
  }
  return typeof input === "number" || typeof input === "boolean" || typeof input === "bigint" ? String(input) : "";
}
