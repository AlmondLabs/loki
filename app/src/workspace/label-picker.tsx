import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { AccountLabel } from "../../../core/frame-types.ts";
import { Meta, Row } from "../components";

export function pickableLabels(labels: readonly AccountLabel[]): AccountLabel[] {
  return labels.filter((l) => l.type === "user").sort((a, b) => a.name.localeCompare(b.name));
}

export function LabelPicker({
  item,
  labelsOf,
  onPick,
  onCancel,
}: {
  item: AttentionItem;
  labelsOf: (item: AttentionItem) => Promise<AccountLabel[] | string>;
  onPick: (labelIds: string[]) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [labels, setLabels] = useState<AccountLabel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hi, setHi] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

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
  useEffect(() => boxRef.current?.focus({ preventScroll: true }), []);
  const ready = labels !== null;
  useEffect(() => {
    if (ready) listRef.current?.focus({ preventScroll: true });
  }, [ready]);

  const cancel = useEffectEvent(onCancel);
  useLayoutEffect(() => {
    const box = boxRef.current;
    const slot = box?.parentElement;
    if (!box || !slot) return;
    const move = slot.parentElement?.querySelector('[data-verb="label"]');
    if (move) box.style.right = `${Math.max(0, slot.getBoundingClientRect().right - move.getBoundingClientRect().right)}px`;
    const away = (e: PointerEvent) => {
      if (!box.contains(e.target as Node)) cancel();
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, []);

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
    e.stopPropagation();
    if (e.key === "Escape") onCancel();
    else if (e.key === "ArrowDown") setHi((i) => Math.min(i + 1, options.length - 1));
    else if (e.key === "ArrowUp") setHi((i) => Math.max(i - 1, 0));
    else if (e.key === "Enter" && options[hi]) choose(options[hi].id);
    else return;
    e.preventDefault();
  };

  return (
    <div ref={boxRef} role="dialog" tabIndex={-1} aria-label="Add a Label" className="loki-popover loki-label-menu flex flex-col gap-0" onKeyDown={onKey}>
      {busy && <Meta>Adding the label…</Meta>}
      {!labels && !error && <Meta>Loading labels…</Meta>}
      {labels?.length === 0 && <Meta wrap>This account has no labels of its own yet. Make them in Gmail.</Meta>}
      {labels && labels.length > 0 && (
        <div
          ref={listRef}
          role="listbox"
          tabIndex={0}
          aria-label="Labels"
          aria-activedescendant={`label-option-${String(hi)}`}
          className="flex flex-col"
          style={{ maxHeight: 200, overflow: "auto" }}
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
              className="loki-truncate"
              style={{ fontSize: "var(--text-sm)" }}
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
