import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { COMPACTION, compactionSteps, messageAt, messageSteps, type ImageNamer, type PiMessage } from "../core/attention/pi-steps.ts";
import type { ChatEvent } from "../core/attention/model.ts";
import { turnIdOf } from "./telemetry.ts";

const DETAIL_CHARS = 300;

export function unansweredDetail(detail: unknown): string | null {
  if (detail === undefined || detail === null) return null;
  const text = (typeof detail === "string" ? detail : JSON.stringify(detail)).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > DETAIL_CHARS ? `${text.slice(0, DETAIL_CHARS - 1)}…` : text;
}

export function unansweredWhy(settled: { status: string; reason?: string; detail?: unknown }): string {
  const detail = unansweredDetail(settled.detail);
  return `${settled.reason ?? settled.status}${detail ? `: ${detail}` : ""}`;
}

function unanswered(reason: string | undefined, detail: unknown): string {
  const said = unansweredDetail(detail);
  const tail = said ? ` (${said})` : "";
  if (reason === "no_model")
    return `this chat's model is not available — connect its provider in Preferences › Providers, or pick another model for the chat${tail}`;
  if (reason === "model_error")
    return `the model could not be reached — is its provider connected in Preferences › Providers? Or pick another model for the chat${tail}`;
  return `the agent could not take this message up${reason ? ` (${reason}${said ? `: ${said}` : ""})` : tail}`;
}

function textBlocks(message: AssistantMessage | undefined): Map<number, string> {
  const out = new Map<number, string>();
  (Array.isArray(message?.content) ? message.content : []).forEach((block, i) => {
    if (block.type === "text") out.set(i, block.text);
  });
  return out;
}

export class ChatEventConverter {
  private partial: { text: string; at: string | null } | null = null;
  private blocks = new Map<number, string>();
  private turnId: string | null = null;
  private readonly blocking = new Set<string>();
  private readonly agentId: string;
  private readonly nameImage?: ImageNamer;

  constructor(agentId = "", nameImage?: ImageNamer) {
    this.agentId = agentId;
    this.nameImage = nameImage;
  }

  inFlight(): { text: string; at: string | null } | null {
    return this.partial?.text ? { ...this.partial } : null;
  }

  convert(ev: AgentEvent, now = new Date().toISOString()): ChatEvent[] {
    switch (ev.type) {
      case "snapshot": {
        this.blocks = textBlocks(ev.generation?.message);
        const text = this.joined();
        this.partial = text ? { text, at: now } : null;
        return [];
      }
      case "run_start":
        this.turnId = turnIdOf(this.agentId, ev.inputs);
        return [{ kind: "loop", state: "running", ...(this.turnId ? { turn_id: this.turnId } : {}) }];
      case "run_end": {
        const turnId = turnIdOf(this.agentId, ev.inputs) ?? this.turnId;
        this.turnId = null;
        this.partial = null;
        this.blocks.clear();
        return [{ kind: "settle" }, { kind: "loop", state: "idle" }, { kind: "turn_end", ...(turnId ? { turn_id: turnId } : {}) }];
      }
      // A message begun. A user message is shown at its end, which comes with it and says what entry it is: a
      case "message_start":
        if (ev.message.role === "user") return [];
        this.blocks = textBlocks(ev.message.role === "assistant" ? ev.message : undefined);
        return this.streamed(now);
      case "message_update": {
        for (const change of ev.changes) {
          if (change.type === "text_start" || change.type === "block") {
            if (change.block.type === "text") this.blocks.set(change.contentIndex, change.block.text);
          } else if (change.type === "text_delta") this.blocks.set(change.contentIndex, (this.blocks.get(change.contentIndex) ?? "") + change.delta);
          else if (change.type === "message") this.blocks = textBlocks(change.message);
        }
        return this.streamed(now);
      }
      case "auto_retry_start":
        this.partial = null;
        this.blocks.clear();
        return [{ kind: "step", step: { kind: "assistant", text: "", at: now } }];
      case "message_end":
        this.partial = null;
        this.blocks.clear();
        return this.answered(ev.entry, now);
      case "tool_execution_end": {
        const result = ev.entry?.model?.[0] as { content?: unknown; isError?: boolean } | undefined;
        // No entry: the tool task faulted or was orphaned; the model is told, and the call shows as failed.
        return [
          {
            kind: "step",
            step: { kind: "result", id: ev.toolCallId, output: result?.content ?? "the tool did not finish", failed: result ? result.isError === true : true },
          },
        ];
      }
      case "compaction_start":
        if (!ev.blocking) return [];
        this.blocking.add(String(ev.taskId));
        return [{ kind: "step", step: { kind: "compaction", state: "running", detail: null, at: now } }];
      case "compaction_end": {
        const shown = this.blocking.delete(String(ev.taskId));
        if (ev.error) return [{ kind: "step", step: { kind: "compaction", state: "failed", detail: ev.error, at: now } }];
        return shown ? [{ kind: "step", step: { kind: "compaction", state: "ended", detail: null, at: now } }] : [];
      }
      case "task_failed":
        return [{ kind: "error", message: ev.message }];
      case "submission":
        if (ev.record.status !== "unanswered") return [];
        return [
          { kind: "error", message: unanswered(ev.record.reason, ev.record.detail) },
          { kind: "settle" },
          { kind: "loop", state: "idle" },
          { kind: "turn_end", turn_id: turnIdOf(this.agentId, [ev.record.id]) ?? undefined },
        ];
      default:
        return [];
    }
  }

  private streamed(now: string): ChatEvent[] {
    const was = this.partial?.text ?? "";
    const text = this.joined();
    if (text === was) return [];
    const at = this.partial?.at ?? now;
    this.partial = text ? { text, at } : null;
    if (text.startsWith(was)) return [{ kind: "step", step: { kind: "assistant", text: text.slice(was.length), at: now, chunk: true } }];
    return [{ kind: "streaming", text, at }];
  }

  private joined(): string {
    return [...this.blocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, text]) => text)
      .join("\n");
  }

  private answered(entry: EntryRecord, now: string): ChatEvent[] {
    const message = entry.model?.[0] as PiMessage | undefined;
    const steps =
      entry.kind === COMPACTION
        ? compactionSteps(entry, now)
        : (entry.kind === "pi.assistant" && message?.role === "assistant") || (entry.kind === "pi.user" && message?.role === "user")
          ? messageSteps(message, messageAt(message) ?? now, message.role === "user" ? this.nameImage : undefined)
          : [];
    return steps.map((step) => ({ kind: "step", step }));
  }
}
