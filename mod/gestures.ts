import type { Gesture, Scope, WidgetManifestEntry } from "../shared/desk-core.ts";
import { getPath } from "../shared/desk-core.ts";

/**
 * The return path. Gestures are described in plain language, logged per desk,
 * and attached to the user's next outbound turn in that conversation. Nothing
 * interrupts the agent; it simply always knows what the user did on the desk.
 */

interface Entry {
  key: string;
  line: string;
}

export class GestureLog {
  private logs = new Map<Scope, Entry[]>();

  /** Append a line. Consecutive entries with the same key collapse (a drag is one move). */
  record(scope: Scope, line: string, key = line): void {
    const arr = this.logs.get(scope) ?? [];
    const last = arr[arr.length - 1];
    if (last && last.key === key) arr[arr.length - 1] = { key, line };
    else arr.push({ key, line });
    if (arr.length > 60) arr.splice(0, arr.length - 60);
    this.logs.set(scope, arr);
  }

  peek(scope: Scope): string[] {
    return (this.logs.get(scope) ?? []).map((e) => e.line);
  }

  drain(scope: Scope): string[] {
    const lines = this.peek(scope);
    this.logs.delete(scope);
    return lines;
  }
}

/** Human line for a gesture, or null for gestures the agent need not hear about. */
export function describeGesture(
  g: Gesture,
  entry: WidgetManifestEntry | undefined,
  before?: Record<string, unknown>,
): { line: string; key: string } | null {
  const name = entry ? `"${entry.title}" (${entry.id})` : `"${g.id}"`;
  switch (g.kind) {
    case "focus":
      return null;
    case "move":
      return {
        key: `move:${g.id}`,
        line: `moved ${name} to (${Math.round(g.position.x)}, ${Math.round(g.position.y)})`,
      };
    case "resize":
      return { key: `resize:${g.id}`, line: `resized ${name} to ${Math.round(g.size.w)}×${Math.round(g.size.h)}` };
    case "close":
      return {
        key: `close:${g.id}`,
        line: `minimised ${name} to the tray — the file still exists`,
      };
    case "open":
      return { key: `open:${g.id}`, line: `restored ${name} from the tray` };
    case "set": {
      const fromServer = before ? getPath(before, g.path) : undefined;
      const prev = fromServer !== undefined ? fromServer : g.prev;
      const was = prev !== undefined ? ` (was ${JSON.stringify(prev)})` : "";
      return { key: `set:${g.id}:${g.path}`, line: `set ${g.path} = ${JSON.stringify(g.value)}${was} on ${name}` };
    }
  }
}

export function formatDeskContext(scope: Scope, lines: string[], widgetsDir = "~/.letta/loki/widgets"): string {
  return [
    `<loki-desk desk="${scope}">`,
    "Canvas activity since your last turn (the user's gestures on the loki desk):",
    ...lines.map((l) => `- ${l}`),
    `Widget files live under ${widgetsDir}/${scope}/; call desk_state for the full picture.`,
    "</loki-desk>",
  ].join("\n");
}

/** Append the block to the last user message in a turn_start input. Approval items are skipped. */
export function attachDeskContext(
  input: Array<Record<string, unknown>>,
  block: string,
): Array<Record<string, unknown>> {
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (item.type === "approval" || item.role !== "user") continue;
    const content = item.content;
    let next: unknown;
    if (typeof content === "string") next = `${content}\n\n${block}`;
    else if (Array.isArray(content)) next = [...content, { type: "text", text: block }];
    else return input;
    const out = input.slice();
    out[i] = { ...item, content: next };
    return out;
  }
  return input;
}
