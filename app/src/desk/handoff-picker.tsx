import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { HandoffSource } from "../../../core/attention/use-attention.ts";
import type { HandoffProposal } from "../../../core/frame-types.ts";
import { Meta, Row, sentence } from "../components";

/**
 * Where an outside card's thread goes when it is handed off (plan 067, R15): loki's proposal first (the chat the
 * thread went to before, or a new chat with the account's agent), then that agent's other open chats. Arrows move,
 * Enter or a click hands off, Esc closes. The desktop draws it in the card above its moves; the phone in its card
 * body, with `touch` rows and sentence case.
 */
export function HandoffPicker({
  item,
  source,
  touch = false,
  onDone,
  onCancel,
}: {
  item: AttentionItem;
  source: HandoffSource;
  touch?: boolean;
  /** The thread went: the card leaves. */
  onDone: () => void;
  onCancel: () => void;
}) {
  const [proposal, setProposal] = useState<HandoffProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hi, setHi] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // The proposal is the account's Mac's to make: asked once per card when the picker opens, dropped if it closes first.
  const ask = useEffectEvent(() => source.handoffPropose(item));
  const card = `${item.agent_id}/${item.id}`;
  useEffect(() => {
    let gone = false;
    void ask().then((p) => {
      if (gone) return;
      if (typeof p === "string") setError(p);
      else setProposal(p);
    });
    return () => {
      gone = true;
    };
  }, [card]);
  // The list takes focus once it is there, so Enter confirms the proposal at once.
  const ready = proposal !== null;
  useEffect(() => {
    if (ready) listRef.current?.focus({ preventScroll: true });
  }, [ready]);

  const options: Array<{ conversation_id: string | null; label: string; meta: string | null }> = proposal
    ? [
        proposal.proposed.kind === "new"
          ? { conversation_id: null, label: proposal.proposed.title, meta: "new chat" }
          : { conversation_id: proposal.proposed.conversation_id, label: proposal.proposed.title, meta: "went here before" },
        ...proposal.choices.map((c) => ({ conversation_id: c.conversation_id, label: c.title, meta: null })),
      ]
    : [];

  const choose = (conversationId: string | null) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void source.handoff(item, conversationId).then((err) => {
      setBusy(false);
      if (err) setError(err);
      else onDone();
    });
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // The deck's own keys (next, archive) wait while the picker is open.
    e.stopPropagation();
    if (e.key === "Escape") onCancel();
    else if (e.key === "ArrowDown") setHi((i) => Math.min(i + 1, options.length - 1));
    else if (e.key === "ArrowUp") setHi((i) => Math.max(i - 1, 0));
    else if (e.key === "Enter" && options[hi]) choose(options[hi].conversation_id);
    else return;
    e.preventDefault();
  };
  const owner = item.outside?.owner_name ?? "its agent";

  return (
    <div role="dialog" aria-label={`Hand off to ${owner}`} onKeyDown={onKey} className="flex flex-col" style={{ gap: touch ? "var(--phone-space-2)" : 6 }}>
      <Meta>{busy ? `Handing off to ${owner}…` : `Hand off to ${owner}`}</Meta>
      {proposal?.note && <Meta wrap>{sentence(proposal.note)}</Meta>}
      {!proposal && !error && <Meta>Asking for its chats…</Meta>}
      {proposal && (
        <div
          ref={listRef}
          role="listbox"
          tabIndex={0}
          aria-label="Chats"
          aria-activedescendant={`handoff-option-${String(hi)}`}
          className="flex flex-col"
          style={{ maxHeight: 200, overflow: "auto" }}
        >
          {options.map((o, i) => (
            <Row
              key={o.conversation_id ?? "new"}
              id={`handoff-option-${String(i)}`}
              role="option"
              tabIndex={-1}
              dense={!touch}
              touch={touch}
              selected={i === hi}
              aria-selected={i === hi}
              disabled={busy}
              onMouseEnter={() => setHi(i)}
              onClick={() => choose(o.conversation_id)}
              style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}
            >
              <span
                className="loki-truncate"
                style={{
                  fontSize: touch ? "var(--phone-text-body)" : "var(--loki-text-body)",
                }}
              >
                {o.label}
              </span>
              {o.meta && <Meta>{sentence(o.meta)}</Meta>}
            </Row>
          ))}
        </div>
      )}
      {error && (
        <Meta negative wrap>
          {sentence(error)}
        </Meta>
      )}
    </div>
  );
}
