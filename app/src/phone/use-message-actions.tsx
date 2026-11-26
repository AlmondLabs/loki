import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import { Button, Sheet } from "../components";
import { MessageHold } from "../chat/transcript";
import { SheetRow } from "./home";

export function useMessageActions(names: { user: string; assistant: string }): { wrap: (thread: ReactNode) => ReactNode; sheet: ReactNode } {
  const [held, setHeld] = useState<{ row: TranscriptRow; selecting: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const close = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setHeld(null);
    setCopied(false);
  };
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(close, 600);
    } catch {
      setHeld((h) => (h ? { ...h, selecting: true } : h));
    }
  };
  const onHold = useCallback((row: TranscriptRow) => setHeld({ row, selecting: false }), []);
  const wrap = (thread: ReactNode) => <MessageHold.Provider value={onHold}>{thread}</MessageHold.Provider>;
  if (!held) return { wrap, sheet: null };
  const { row, selecting } = held;
  const who = row.role === "user" ? names.user : names.assistant;
  const sheet = (
    <Sheet label={`Message from ${who}`} onClose={close} placement="bottom" className="loki-phone-sheet">
      <div className="loki-phone-sheet-head">
        <div className="loki-phone-sheet-copy">
          <div className="loki-phone-title loki-phone-ellipsis">{selecting ? "Select text" : who}</div>
          {!selecting && <div className="loki-phone-meta loki-phone-message-preview">{row.text}</div>}
        </div>
      </div>
      {selecting ? (
        <div className="loki-phone-select-text" tabIndex={0} aria-label="The message's text">
          {row.text}
        </div>
      ) : (
        <ul className="loki-phone-list">
          <SheetRow icon={copied ? "check" : "copy"} label={copied ? "Copied" : "Copy"} onClick={() => void copy(row.text)} />
          <SheetRow icon="select" label="Select text" onClick={() => setHeld({ row, selecting: true })} />
        </ul>
      )}
      <Button size="touch" tone="paper" block onClick={close}>
        {selecting ? "Done" : "Cancel"}
      </Button>
    </Sheet>
  );
  return { wrap, sheet };
}
