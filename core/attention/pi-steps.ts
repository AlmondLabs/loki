import { contentImages, contentText, toolArgsShown, toolOutput } from "../harness.ts";
import type { Step, StoredStep } from "./thread.ts";

export interface PiMessage {
  role?: string;
  content?: unknown;
  toolCallId?: unknown;
  isError?: unknown;
  timestamp?: unknown;
  /** An assistant message's end: "error" when the model call failed, with the provider's `errorMessage`. */
  stopReason?: unknown;
  errorMessage?: unknown;
}

export interface PiEntry {
  kind: string;
  model?: readonly PiMessage[];
  data?: unknown;
}

export type ImageNamer = (image: { data: string; mimeType: string }) => string | null;

export function messageAt(m: PiMessage): string | null {
  return typeof m.timestamp === "number" && Number.isFinite(m.timestamp) ? new Date(m.timestamp).toISOString() : null;
}

export function messageSteps(m: PiMessage, at: string | null, nameImage?: ImageNamer): StoredStep[] {
  if (m.role === "toolResult")
    return typeof m.toolCallId === "string" ? [shownStep({ kind: "result", id: m.toolCallId, output: m.content, failed: m.isError === true })] : [];
  if (m.role !== "user" && m.role !== "assistant") return [];
  const text = contentText(m.content);
  if (m.role === "user") {
    const images = nameImage ? contentImages(m.content).flatMap((image) => nameImage(image) ?? []) : [];
    return [{ kind: "user", raw: text, at, ...(images.length ? { images } : {}) }];
  }
  const thought = thinkingText(m.content);
  const out: StoredStep[] = [...(thought ? [{ kind: "thinking" as const, text: thought, at }] : []), { kind: "assistant", text, at }];
  for (const part of Array.isArray(m.content) ? m.content : []) {
    const p = part as { type?: string; name?: string; arguments?: unknown; id?: unknown; tool_kind?: unknown } | null;
    if (p?.type === "toolCall" && p.name)
      out.push(
        shownStep({
          kind: "call",
          name: p.name,
          args: p.arguments,
          id: typeof p.id === "string" ? p.id : null,
          at,
          ...(typeof p.tool_kind === "string" ? { tool_kind: p.tool_kind } : {}),
        }),
      );
  }
  if (out.length === (thought ? 2 : 1) && !text.trim() && m.stopReason === "error" && typeof m.errorMessage === "string" && m.errorMessage.trim())
    return [{ kind: "failed", message: m.errorMessage.trim().replace(/\s+/g, " "), at }];
  return out;
}

function thinkingText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    const p = part as { type?: unknown; thinking?: unknown } | null;
    if (p?.type === "thinking" && typeof p.thinking === "string" && p.thinking.trim()) parts.push(p.thinking.trim());
  }
  return parts.join("\n\n");
}

export function shownStep(step: StoredStep): StoredStep;
export function shownStep(step: Step): Step;
export function shownStep(step: Step): Step {
  if (step.kind === "result") return { ...step, output: toolOutput(step.output) };
  if (step.kind === "call" || step.kind === "approval") return { ...step, args: toolArgsShown(step.args) };
  return step;
}

const SHOWN = new Set(["pi.user", "pi.assistant", "pi.tool-result"]);

export const COMPACTION = "pi.compaction";

function summaryOf(m: PiMessage): string | null {
  const text = contentText(m.content);
  const inner = /<summary>\n?([\s\S]*?)\n?<\/summary>/.exec(text)?.[1] ?? text;
  return inner.trim() || null;
}

export function compactionSteps(entry: PiEntry, at: string | null = null): StoredStep[] {
  const m = entry.kind === COMPACTION ? entry.model?.[0] : undefined;
  return m ? [{ kind: "compaction", state: "done", detail: summaryOf(m), at: messageAt(m) ?? at }] : [];
}

const BRANCH = "loki.branch";

export function entrySteps(entry: PiEntry, nameImage?: ImageNamer): StoredStep[] {
  if (entry.kind === BRANCH) {
    const message = (entry.data as { message?: PiMessage } | undefined)?.message;
    return message ? messageSteps(message, messageAt(message), nameImage) : [];
  }
  if (entry.kind === COMPACTION) return compactionSteps(entry);
  if (!SHOWN.has(entry.kind)) return [];
  return (entry.model ?? []).flatMap((m) => messageSteps(m, messageAt(m), nameImage));
}
