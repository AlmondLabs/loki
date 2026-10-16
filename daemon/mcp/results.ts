import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/client";

/**
 * An MCP result as the model reads it. Text, images and resources map across. A result too big for the conversation
 * (past SPILL_CHARS, about 12,500 tokens) is saved whole to a file under the chat's folder, and the model gets
 * its path, its size and its start, to read more with its file tools if it needs to: Claude Code's limits, and
 * Cursor's file instead of a cut. An error keeps its first and last ERROR_KEEP characters.
 */

/** A text result past this many characters spills to a file. */
export const SPILL_CHARS = 50_000;
/** How much of a spilled result's start the model gets with its path. */
export const START_CHARS = 4_000;
/** How many characters a long error keeps from each end. */
export const ERROR_KEEP = 5_000;

/** One piece of a mapped result: text, or a base64 image. */
export type Part = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
/** A result as mapped: `spilled` is the file a too-big one was saved to (null when it fit or could not be saved), and `chars` its text's whole length, for analytics. */
export interface Mapped {
  content: Part[];
  isError: boolean;
  spilled: string | null;
  chars: number;
}

/** Roughly how many tokens a text is (four characters a token). */
const tokensOf = (chars: number) => Math.ceil(chars / 4);

/** A field of a server's content block as text: a string or number as it is, anything else nothing. */
const text = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

function parts(result: Partial<CallToolResult>): Part[] {
  const out: Part[] = [];
  for (const block of result.content ?? []) {
    const b = block as Record<string, unknown> & { type: string };
    if (b.type === "text" && typeof b.text === "string") out.push({ type: "text", text: b.text });
    else if (b.type === "image" && typeof b.data === "string")
      out.push({ type: "image", data: b.data, mimeType: typeof b.mimeType === "string" ? b.mimeType : "image/png" });
    else if (b.type === "resource_link") out.push({ type: "text", text: `[resource] ${text(b.name ?? b.title)} ${text(b.uri)}`.trim() });
    else if (b.type === "resource") {
      const r = (b.resource ?? {}) as { uri?: string; text?: string; blob?: string; mimeType?: string };
      if (typeof r.text === "string") out.push({ type: "text", text: r.text });
      else out.push({ type: "text", text: `[resource ${r.mimeType ?? "binary"}] ${r.uri ?? ""}`.trim() });
    } else if (b.type === "audio") out.push({ type: "text", text: `[audio ${text(b.mimeType)}, not shown]` });
  }
  // A result with only structured content still says something.
  if (!out.length && result.structuredContent !== undefined) out.push({ type: "text", text: JSON.stringify(result.structuredContent, null, 2) });
  return out;
}

/** An error's text cut to its first and last ERROR_KEEP characters when it is long. */
export function trimError(text: string): string {
  if (text.length <= ERROR_KEEP * 2 + 1000) return text;
  return `${text.slice(0, ERROR_KEEP)}\n… [${text.length - ERROR_KEEP * 2} characters cut] …\n${text.slice(-ERROR_KEEP)}`;
}

let spills = 0;

/**
 * Map a result; `spillDir` is where a too-big one is saved (`<loki>/tool-results/<chat>`), `name` names its file. A
 * spill that cannot be written falls back to a cut, and says how much was cut.
 */
export function mapResult(result: CallToolResult, opts: { spillDir: string; name: string }): Mapped {
  const content = parts(result);
  const isError = result.isError === true;
  const text = content
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  const chars = text.length;
  if (isError) return { content: content.map((p) => (p.type === "text" ? { ...p, text: trimError(p.text) } : p)), isError, spilled: null, chars };
  if (chars <= SPILL_CHARS) return { content, isError, spilled: null, chars };
  const images = content.filter((p) => p.type === "image");
  const start = text.slice(0, START_CHARS);
  try {
    mkdirSync(opts.spillDir, { recursive: true });
    const file = join(opts.spillDir, `${opts.name.replace(/[^A-Za-z0-9_.-]+/g, "_")}-${Date.now().toString(36)}-${++spills}.txt`);
    writeFileSync(file, text);
    const note = `The result was too large for the conversation (${chars.toLocaleString("en")} characters, about ${tokensOf(chars).toLocaleString("en")} tokens), so it was saved whole to\n${file}\nRead more of it with your file tools if you need to. Its start:\n\n${start}`;
    return { content: [{ type: "text", text: note }, ...images], isError, spilled: file, chars };
  } catch (error) {
    const note = `The result was too large for the conversation (${chars.toLocaleString("en")} characters) and could not be saved to a file (${error instanceof Error ? error.message : String(error)}); here is its first ${START_CHARS.toLocaleString("en")}:\n\n${start}`;
    return { content: [{ type: "text", text: note }, ...images], isError, spilled: null, chars };
  }
}
