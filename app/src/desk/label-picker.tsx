import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { AccountLabel } from "../../../core/frame-types.ts";
import { Meta, Row } from "../components";

/**
 * The labels an email card offers (plan 070, R12): the account's own, by name. Gmail's system labels (Inbox, Unread,
 * Sent and the like) are what read, later and archive already move, so they are not offered here.
 */
export function pickableLabels(labels: readonly AccountLabel[]): AccountLabel[] {
  return labels.filter((l) => l.type === "user").sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The label picker L opens on an email card: the account's labels, asked for once when it opens. Arrows move, Enter
 * or a click adds the label to the thread, and the card stays for the next key; Esc closes with nothing added. Drawn
 * in the card above its moves, as the hand-off picker is.
 */
export function LabelPicker({
  item,
  labelsOf,
  onPick,
  onCancel,
}: {
  item: AttentionItem;
  /** The account's labels, or why they could not be had. */
  labelsOf: (item: AttentionItem) => Promise<AccountLabel[] | string>;
  /** Add these labels to the thread; resolves to the reason when refused, or null, and the picker closes. */
  onPick: (labelIds: string[]) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [labels, setLabels] = useState<AccountLabel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hi, setHi] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // The labels are the account's to list: asked once per card when the picker opens, dropped if it closes first.
  const ask = useEffectEvent(() => labelsOf(item));
  const card = `${item.agent_id}/${item.id}`;
  useEffect(() => {
    let gone = false;
    void ask().then((out) => {
      if (gone) return;
      if (typeof out === "string") setError(out);
      else setLabels(pickableLabels(out));
    });
    return () => {
      gone = true;
    };
  }, [card]);
  // The picker holds focus while the labels come (and when there are none), so Esc closes it; then the list takes it.
  useEffect(() => boxRef.current?.focus({ preventScroll: true }), []);
  const ready = labels !== null;
  useEffect(() => {
    if (ready) listRef.current?.focus({ preventScroll: true });
  }, [ready]);

  const options = labels ?? [];
  const choose = (id: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void onPick([id]).then((err) => {
      setBusy(false);
      if (err) setError(err);
    });
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // The deck's own keys wait while the picker is open.
    e.stopPropagation();
    if (e.key === "Escape") onCancel();
    else if (e.key === "ArrowDown") setHi((i) => Math.min(i + 1, options.length - 1));
    else if (e.key === "ArrowUp") setHi((i) => Math.max(i - 1, 0));
    else if (e.key === "Enter" && options[hi]) choose(options[hi].id);
    else return;
    e.preventDefault();
  };

  return (
    <div ref={boxRef} role="dialog" tabIndex={-1} aria-label="add a label" onKeyDown={onKey} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <Meta>{busy ? "adding the label…" : "add a label"}</Meta>
      {!labels && !error && <Meta>asking for its labels…</Meta>}
      {labels?.length === 0 && <Meta wrap>this account has no labels of its own yet: make them in Gmail</Meta>}
      {labels && labels.length > 0 && (
        <div
          ref={listRef}
          role="listbox"
          tabIndex={0}
          aria-label="labels"
          aria-activedescendant={`label-option-${String(hi)}`}
          style={{ display: "flex", flexDirection: "column", maxHeight: 200, overflow: "auto" }}
        >
          {labels.map((l, i) => (
            <Row
              key={l.id}
              id={`label-option-${String(i)}`}
              role="option"
              tabIndex={-1}
              dense
              selected={i === hi}
              aria-selected={i === hi}
              disabled={busy}
              onMouseEnter={() => setHi(i)}
              onClick={() => choose(l.id)}
              style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "var(--loki-text-body)" }}
            >
              {l.name}
            </Row>
          ))}
        </div>
      )}
      {error && (
        <Meta negative wrap>
          {error}
        </Meta>
      )}
    </div>
  );
}
