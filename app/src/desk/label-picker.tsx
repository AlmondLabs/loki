import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { AccountLabel } from "../../../core/frame-types.ts";
import { Meta, Row } from "../components";
import { useLook } from "../theme";

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
 * in the card above its moves, as the hand-off picker is. Under Liquid Glass (plan 2026-11-12-1505, U20) it is a menu
 * hung over the card from its Label move, dimming nothing, and a press outside it closes it as Esc does.
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

  // Under Liquid Glass the menu lines up with the Label move it opened from, and a press anywhere else puts it away.
  const glass = useLook() === "glass";
  const cancel = useEffectEvent(onCancel);
  useLayoutEffect(() => {
    const box = boxRef.current;
    const slot = box?.parentElement;
    if (!glass || !box || !slot) return;
    const move = slot.parentElement?.querySelector('[data-verb="label"]');
    if (move) box.style.right = `${Math.max(0, slot.getBoundingClientRect().right - move.getBoundingClientRect().right)}px`;
    const away = (e: PointerEvent) => {
      if (!box.contains(e.target as Node)) cancel();
    };
    // capture phase: the card stops pointerdown from bubbling, and a press there must still close the menu
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, [glass]);

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
    <div
      ref={boxRef}
      role="dialog"
      tabIndex={-1}
      aria-label={glass ? "Add a Label" : "add a label"}
      className={glass ? "loki-popover loki-label-menu" : undefined}
      onKeyDown={onKey}
      style={{ display: "flex", flexDirection: "column", gap: glass ? 0 : 6 }}
    >
      {glass ? busy && <Meta>Adding the label…</Meta> : <Meta>{busy ? "adding the label…" : "add a label"}</Meta>}
      {!labels && !error && <Meta>{glass ? "Loading labels…" : "asking for its labels…"}</Meta>}
      {labels?.length === 0 && (
        <Meta wrap>
          {glass ? "This account has no labels of its own yet. Make them in Gmail." : "this account has no labels of its own yet: make them in Gmail"}
        </Meta>
      )}
      {labels && labels.length > 0 && (
        <div
          ref={listRef}
          role="listbox"
          tabIndex={0}
          aria-label={glass ? "Labels" : "labels"}
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
