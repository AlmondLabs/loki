import { useCallback, useState, type ReactNode } from "react";
import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import { Button, Sheet } from "../components";
import { MessageHold } from "../chat/Transcript";
import { SheetRow } from "./Home";

/**
 * A message's actions on the phone, as iOS and Slack's app offer them: a long press on any message, yours or
 * the agent's, opens a sheet with Copy (the message as written, markdown and all) and Select text, which shows
 * the message on its own where the browser's selection works again (the thread keeps it off so the long press
 * is ours). `wrap` goes round the thread; `sheet` is drawn beside it.
 */
export function useMessageActions(names: { user: string; assistant: string }): { wrap: (thread: ReactNode) => ReactNode; sheet: ReactNode } {
  const [held, setHeld] = useState<{ row: TranscriptRow; selecting: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const close = () => {
    setHeld(null);
    setCopied(false);
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(close, 600);
    } catch {
      // the clipboard refused (no permission here): Select text still lets the person copy it themselves
      setHeld((h) => (h ? { ...h, selecting: true } : h));
    }
  };
  // One handler for the page's life: a fresh one would re-render every message on each streamed update.
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
        <div className="loki-phone-select-text" tabIndex={0} aria-label="the message's text">
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
