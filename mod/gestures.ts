import type { Gesture, Scope, WidgetManifestEntry } from "../core/desk-core.ts";
import { getPath } from "../core/desk-core.ts";

interface Entry {
  key: string;
  line: string;
}

export class GestureLog {
  private logs = new Map<Scope, Entry[]>();

  record(scope: Scope, line: string, key = line): void {
    const arr = this.logs.get(scope) ?? [];
    const last = arr.at(-1);
    if (last?.key === key) arr[arr.length - 1] = { key, line };
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

export function describeGesture(g: Gesture, entry: WidgetManifestEntry | undefined, before?: Record<string, unknown>): { line: string; key: string } | null {
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

export function formatDeskContext(scope: Scope, lines: string[], widgetsDir = "~/.loki/widgets"): string {
  return [
    `<loki-desk desk="${scope}">`,
    "Canvas activity since your last turn (the user's gestures on the loki canvas):",
    ...lines.map((l) => `- ${l}`),
    `Widget files live under ${widgetsDir}/${scope}/; read the canvas with canvas_read in a script for the full picture.`,
    "</loki-desk>",
  ].join("\n");
}

export function attachDeskContext(content: string | Array<Record<string, unknown>>, block: string): string | Array<Record<string, unknown>> {
  return typeof content === "string" ? `${content}\n\n${block}` : [...content, { type: "text", text: block }];
}
