import type { ConversationView, EntryRecord, LiveState } from "@earendil-works/pi-durable";
import { COMPACTION, compactionSteps, messageAt, messageSteps, type ImageNamer, type PiMessage } from "../core/attention/pi-steps.ts";
import type { ChatEvent } from "../core/attention/model.ts";

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

function joinedText(message: { readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }> } | undefined): string {
  const parts: string[] = [];
  for (const block of message?.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

function liveOf(view: ConversationView): LiveState | undefined {
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- tsgolint 7.0.2005 calls this a no-op, but tsc needs it: view.docs values are typed as JsonObject.
  return view.docs["pi.live"] as LiveState | undefined;
}

export class ChatEventConverter {
  private partial: { text: string; at: string | null } | null = null;
  private lastEntryId = 0;
  private running = false;
  private retryAt: number | null = null;
  private doneTools = new Set<string>();
  private blockingCompactions = new Set<number>();
  private activeCompactions = new Set<number>();
  private lastCompactionFailureId: number | null = null;
  private lastRunFailureKey: string | null = null;
  private lastCompactionEnded = false;
  private readonly nameImage?: ImageNamer;

  constructor(_agentId = "", nameImage?: ImageNamer) {
    this.nameImage = nameImage;
  }

  inFlight(): { text: string; at: string | null } | null {
    return this.partial?.text ? { ...this.partial } : null;
  }

  compactionEnded(): boolean {
    return this.lastCompactionEnded;
  }

  seed(view: ConversationView, now = new Date().toISOString()): void {
    const live = liveOf(view);
    this.lastEntryId = view.entries.at(-1)?.id ?? 0;
    this.running = Boolean(live?.run);
    this.retryAt = live?.generation?.retry?.at ?? null;
    const text = joinedText(live?.generation?.message);
    this.partial = text ? { text, at: now } : null;
    this.doneTools = new Set((live?.tools ?? []).filter((t) => t.status === "done").map((t) => t.callId));
    this.blockingCompactions = new Set((live?.compactions ?? []).filter((c) => c.blocking).map((c) => Number(c.taskId)));
    this.activeCompactions = new Set((live?.compactions ?? []).map((c) => Number(c.taskId)));
    this.lastCompactionFailureId = live?.compactionFailure ? Number(live.compactionFailure.taskId) : null;
    this.lastRunFailureKey = live?.runFailure ? `${String(live.runFailure.taskId)}:${live.runFailure.inputs.join(",")}` : null;
    this.lastCompactionEnded = false;
  }

  convert(view: ConversationView, now = new Date().toISOString()): ChatEvent[] {
    const live = liveOf(view);
    const out: ChatEvent[] = [];
    this.lastCompactionEnded = false;

    if (!this.running && live?.run) {
      this.running = true;
      out.push({ kind: "loop", state: "running" });
    }

    for (const entry of view.entries) {
      if (entry.id <= this.lastEntryId) continue;
      this.lastEntryId = entry.id;
      if (entry.kind === "pi.assistant") {
        this.partial = null;
        out.push(...this.answered(entry, now));
      } else if (entry.kind === COMPACTION) {
        this.lastCompactionEnded = true;
        out.push(...this.answered(entry, now));
      } else if (entry.kind === "pi.user") {
        out.push(...this.answered(entry, now));
      } else if (entry.kind === "pi.tool-result") {
        const result = entry.model?.[0] as { toolCallId?: string; content?: unknown; isError?: boolean } | undefined;
        if (result?.toolCallId) {
          this.doneTools.add(result.toolCallId);
          out.push({
            kind: "step",
            step: { kind: "result", id: result.toolCallId, output: result.content ?? "the tool did not finish", failed: result.isError === true },
          });
        }
      }
    }

    if (live?.tools) {
      for (const slot of live.tools) {
        if (slot.status === "done" && slot.entry === undefined && !this.doneTools.has(slot.callId)) {
          this.doneTools.add(slot.callId);
          out.push({ kind: "step", step: { kind: "result", id: slot.callId, output: "the tool did not finish", failed: true } });
        }
      }
    } else {
      this.doneTools.clear();
    }

    if (live?.generation?.retry !== undefined) {
      if (live.generation.retry.at !== this.retryAt) {
        this.retryAt = live.generation.retry.at;
        this.partial = null;
        out.push({ kind: "step", step: { kind: "assistant", text: "", at: now } });
      }
    } else {
      this.retryAt = null;
    }

    if (live?.run && live.generation?.message && !live.generation.retry) {
      const was = this.partial?.text ?? "";
      const text = joinedText(live.generation.message);
      if (text !== was) {
        const at = this.partial?.at ?? now;
        this.partial = text ? { text, at } : null;
        if (text) {
          if (text.startsWith(was)) out.push({ kind: "step", step: { kind: "assistant", text: text.slice(was.length), at: now, chunk: true } });
          else out.push({ kind: "streaming", text, at });
        }
      }
    } else if (!live?.generation?.message) {
      this.partial = null;
    }

    const currentCompactions = live?.compactions ?? [];
    const currentIds = new Set(currentCompactions.map((c) => Number(c.taskId)));
    for (const c of currentCompactions) {
      const id = Number(c.taskId);
      if (c.blocking && !this.blockingCompactions.has(id)) {
        this.blockingCompactions.add(id);
        out.push({ kind: "step", step: { kind: "compaction", state: "running", detail: null, at: now } });
      }
    }
    if (live?.compactionFailure && Number(live.compactionFailure.taskId) !== this.lastCompactionFailureId) {
      const id = Number(live.compactionFailure.taskId);
      this.lastCompactionFailureId = id;
      this.blockingCompactions.delete(id);
      this.lastCompactionEnded = true;
      out.push({ kind: "step", step: { kind: "compaction", state: "failed", detail: live.compactionFailure.error, at: now } });
    }
    for (const id of [...this.blockingCompactions]) {
      if (!currentIds.has(id)) {
        this.blockingCompactions.delete(id);
        out.push({ kind: "step", step: { kind: "compaction", state: "ended", detail: null, at: now } });
      }
    }
    for (const id of this.activeCompactions) {
      if (!currentIds.has(id)) this.lastCompactionEnded = true;
    }
    this.activeCompactions = currentIds;

    const rf = live?.runFailure;
    const rfKey = rf ? `${String(rf.taskId)}:${rf.inputs.join(",")}` : null;
    const newFailure = rf !== undefined && rfKey !== this.lastRunFailureKey;
    if (newFailure) {
      this.lastRunFailureKey = rfKey;
      out.push({ kind: "error", message: unanswered(rf.reason, rf.detail) });
    }

    if (!live?.run && (this.running || newFailure)) {
      this.running = false;
      this.partial = null;
      out.push({ kind: "settle" }, { kind: "loop", state: "idle" }, { kind: "turn_end" });
    } else if (newFailure && live?.run) {
      out.push({ kind: "settle" }, { kind: "turn_end" });
    }

    return out;
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
