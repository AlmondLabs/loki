import { useCallback, useEffect, useRef } from "react";
import type { Attachment } from "../../../core/attention/content.ts";

export interface FirstMessage {
  scope: string;
  runtime: { agent_id: string; conversation_id: string };
  text: string;
  images: Attachment[];
  left: boolean;
}

export function firstMessageStep(waiting: FirstMessage, scope: string, connection: string): FirstMessage | "send" {
  if (scope !== waiting.scope) return waiting;
  if (connection !== "open") return waiting.left ? waiting : { ...waiting, left: true };
  return waiting.left ? "send" : waiting;
}

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
