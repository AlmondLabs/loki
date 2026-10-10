import { contentText, messageText } from "../../core/harness.ts";
import { applyChatEvent, type ChatEvent, type Live } from "../../core/attention/model.ts";
import type { ServerEvent } from "../../core/attention/protocol.ts";
import type { Step } from "../../core/attention/thread.ts";

/**
 * Letta Code's app-server events, as loki's chat events: how loki's live-chat and thread tests describe a turn. loki
 * ran on Letta until plan 017; these tests were written in Letta's shapes, and what they check — the live state and
 * the thread folding loki's chat events (core/attention/model.ts applyChatEvent) — is loki's own.
 */

/**
 * Letta protocol messages from conversation_messages_list, oldest first, as thread steps (core/attention/thread.ts).
 * Reasoning is dropped; the rest is the thread's to fold.
 */
export function historySteps(messages: Array<Record<string, unknown>>): Step[] {
  const out: Step[] = [];
  for (const m of messages) {
    const at = typeof m.date === "string" ? m.date : null;
    const step = protocolStep(m, at);
    if (step) out.push(step);
  }
  return out;
}

/** One Letta protocol message, from history or a stream delta, as a thread step; null for anything a thread does not show. */
export function protocolStep(m: Record<string, unknown> | undefined, at: string | null, chunk = false): Step | null {
  switch (m?.message_type) {
    case "user_message":
      return { kind: "user", raw: contentText(m.content), at };
    case "assistant_message":
      // A streamed piece is part of a word as often as a whole line: the pieces join as they came.
      return { kind: "assistant", text: chunk ? messageText(m.content) : contentText(m.content), at, ...(chunk ? { chunk } : {}) };
    case "tool_call_message":
    case "approval_request_message": {
      const tc = m.tool_call as { name?: string; arguments?: unknown; tool_call_id?: string } | undefined;
      if (!tc?.name) return null;
      return { kind: m.message_type === "tool_call_message" ? "call" : "approval", name: tc.name, args: tc.arguments, id: tc.tool_call_id ?? null, at };
    }
    case "tool_return_message":
      return typeof m.tool_call_id === "string" ? { kind: "result", id: m.tool_call_id, output: m.tool_return, failed: m.status === "error" } : null;
    default:
      return null;
  }
}


/** One Letta app-server event as chat events. */
export function lettaChatEvents(ev: ServerEvent, now: string): ChatEvent[] {
  switch (ev.type) {
    case "control_request": {
      const req = ev.request as { subtype?: string; tool_name?: string; input?: unknown } | undefined;
      if (req?.subtype !== "can_use_tool") return [];
      const requestId = String(ev.request_id);
      return req.tool_name === "AskUserQuestion" ? [{ kind: "question", requestId, input: req.input }] : [{ kind: "approval", requestId, toolName: req.tool_name ?? "tool", input: req.input }];
    }
    case "update_device_status": {
      const status = ev.device_status as { current_permission_mode?: string; current_working_directory?: string } | undefined;
      return [{ kind: "device", ...(status?.current_permission_mode ? { mode: status.current_permission_mode } : {}), ...(status?.current_working_directory ? { cwd: status.current_working_directory } : {}) }];
    }
    case "update_loop_status": {
      const status = (ev.loop_status as { status?: string } | undefined)?.status;
      if (!status) return [];
      const state = status === "WAITING_ON_INPUT" ? "idle" : status === "WAITING_ON_APPROVAL" ? "approval" : "running";
      return [{ kind: "loop", state, detail: status }];
    }
    case "stream_delta": {
      const d = ev.delta as Record<string, unknown> | undefined;
      const mt = d?.message_type;
      const step = protocolStep(d, now, true);
      if (step) return [{ kind: "step", step }];
      if (mt === "error_message" || mt === "loop_error") return [{ kind: "error", message: String((d as { message?: string })?.message ?? "the turn failed") }];
      if (mt === "slash_command_start" || mt === "slash_command_end") {
        const c = d as { command_id?: string; input?: string; output?: string; success?: boolean };
        const input = typeof c.input === "string" && c.input ? c.input : `/${c.command_id ?? "command"}`;
        return [mt === "slash_command_start" ? { kind: "command", phase: "start", input } : { kind: "command", phase: "end", input, success: c.success !== false, output: typeof c.output === "string" ? c.output : "" }];
      }
      if (mt === "stop_reason") return [{ kind: "settle" }];
      return [];
    }
    case "turn_finished":
      return [{ kind: "turn_end" }];
    default:
      return [];
  }
}

/** Fold one Letta app-server event into a conversation's live state. */
export function applyEvent(l: Live, ev: ServerEvent, now = new Date().toISOString()): { changed: boolean; userSpoke: boolean } {
  let changed = false;
  let userSpoke = false;
  for (const e of lettaChatEvents(ev, now)) {
    const r = applyChatEvent(l, e, now);
    changed ||= r.changed;
    userSpoke ||= r.userSpoke;
  }
  return { changed, userSpoke };
}

