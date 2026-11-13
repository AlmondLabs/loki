import { useCallback, useEffect, useRef } from "react";
import type { Attachment } from "../../../core/attention/content.ts";

/** A new chat's first message, waiting for the link to its chat: `left` once the link to the chat before it has gone. */
export interface FirstMessage {
  /** The chat's scope, as the pane shows it, and the chat itself, to send to. */
  scope: string;
  runtime: { agent_id: string; conversation_id: string };
  text: string;
  images: Attachment[];
  left: boolean;
}

/**
 * Whether a waiting first message can go now. Opening a chat renews the link (desk/use-desk-socket.ts), and what was
 * asked on the old one is lost; so the message waits until the pane is on its chat and the link has been seen down
 * and then open again. Returns "send", or the message as it waits on.
 */
export function firstMessageStep(waiting: FirstMessage, scope: string, connection: string): FirstMessage | "send" {
  if (scope !== waiting.scope) return waiting;
  if (connection !== "open") return waiting.left ? waiting : { ...waiting, left: true };
  return waiting.left ? "send" : waiting;
}

/**
 * The first message of a chat made by sending it (⌘N under Liquid Glass, plan 2026-11-12-1505 U20): `queue` holds it
 * while the pane switches to the new chat, and `send` gets it once that chat's link is open.
 */
export function useFirstMessage(scope: string, connection: string, send: (m: FirstMessage) => void): (m: Omit<FirstMessage, "left">) => void {
  const waiting = useRef<FirstMessage | null>(null);
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });
  useEffect(() => {
    if (!waiting.current) return;
    const next = firstMessageStep(waiting.current, scope, connection);
    if (next !== "send") {
      waiting.current = next;
      return;
    }
    const message = waiting.current;
    waiting.current = null;
    sendRef.current(message);
  }, [scope, connection]);
  return useCallback((m) => {
    waiting.current = { ...m, left: false };
  }, []);
}
