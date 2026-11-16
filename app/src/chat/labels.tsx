import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Button, Field, Sheet } from "../components";
import { Icon } from "../shared/icons";
import { LABELS_PER_CHAT, LABEL_COLORS, LABEL_MAX, chatLabels, labelName, type LabelView } from "../../../core/labels.ts";
import { messageOf } from "../../../core/errors.ts";

const LABEL_COLOR_VARS = [
  "var(--loki-label-0)",
  "var(--loki-label-1)",
  "var(--loki-label-2)",
  "var(--loki-label-3)",
  "var(--loki-label-4)",
  "var(--loki-label-5)",
  "var(--loki-label-6)",
  "var(--loki-label-7)",
] as const;

export const paletteColor = (index: number): string => LABEL_COLOR_VARS[index % LABEL_COLORS];

export function labelColor(name: string, list: readonly LabelView[] | null): string {
  const known = list?.find((l) => l.name === name)?.color;
  if (known !== undefined) return LABEL_COLOR_VARS[known % LABEL_COLORS];
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return LABEL_COLOR_VARS[hash % LABEL_COLORS];
}

export function LabelChips({
  labels,
  list,
  max,
  onPick,
  dots = false,
}: {
  labels: readonly string[] | undefined;
  list: readonly LabelView[] | null;
  max?: number;
  onPick?: (name: string) => void;
  dots?: boolean;
}) {
  if (!labels?.length) return null;
  if (dots) {
    const shown = labels.slice(0, max ?? labels.length);
    return (
      <span className="loki-labels loki-labels--dots" title={labels.join(", ")}>
        <span className="sr-only">{`labels: ${labels.join(", ")}`}</span>
        {shown.map((name) => (
          <span key={name} aria-hidden className="loki-label-dot" style={{ "--label-tone": labelColor(name, list) } as CSSProperties} />
        ))}
        {labels.length > shown.length && (
          <span aria-hidden className="loki-label-more">
            +{labels.length - shown.length}
          </span>
        )}
      </span>
    );
  }
  const shown = max === undefined ? labels : labels.slice(0, max);
  const rest = labels.length - shown.length;
  return (
    <span className="loki-labels">
      {shown.map((name) => {
        const style = { "--label-tone": labelColor(name, list) } as CSSProperties;
        const inner = (
          <>
            <span aria-hidden className="loki-label-dot" />
            {name}
          </>
        );
        return onPick ? (
          <button key={name} type="button" className="loki-label-chip" style={style} onClick={() => onPick(name)} title={`Show the chats labelled ${name}`}>
            {inner}
          </button>
        ) : (
          <span key={name} className="loki-label-chip" style={style}>
            {inner}
          </span>
        );
      })}
      {rest > 0 && (
        <span className="loki-label-more" title={labels.slice(shown.length).join(", ")}>
          +{rest}
        </span>
      )}
    </span>
  );
}

export function LabelEditor({
  current,
  list,
  touch = false,
  onChange,
}: {
  current: readonly string[];
  list: readonly LabelView[] | null;
  touch?: boolean;
  onChange: (labels: string[]) => Promise<string | null>;
}) {
  const [query, setQuery] = useState("");
  const [labels, setLabels] = useState<string[]>([...current]);
  const [error, setError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => fieldRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);

  const typed = labelName(query);
  const known = (list ?? []).map((l) => l.name);
  const all = [...new Set([...labels, ...known])];
  const q = query.trim().toLowerCase();
  const matches = all.filter((name) => !q || name.includes(typed ?? q)).sort((a, b) => Number(labels.includes(b)) - Number(labels.includes(a)));
  const canCreate = typed !== null && !all.includes(typed);
  const full = labels.length >= LABELS_PER_CHAT;

  const save = async (next: string[]) => {
    const before = labels;
    setLabels(next);
    setError(null);
    const err = await onChange(next).catch((e: unknown) => messageOf(e));
    if (err) {
      setLabels(before);
      setError(err);
    }
  };
  const toggle = (name: string) => {
    if (labels.includes(name)) void save(labels.filter((l) => l !== name));
    else if (!full) void save([...labels, name]);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    const first = matches.at(0) ?? (canCreate ? typed : undefined);
    if (!first) return;
    if (!labels.includes(first)) toggle(first);
    setQuery("");
  };

  return (
    <div className="loki-label-editor" data-touch={touch || undefined}>
      <Field
        ref={fieldRef}
        size={touch ? "touch" : "sm"}
        name="label-filter"
        aria-label="Find or create a label"
        placeholder="Find or create a label"
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        data-form-type="other"
        spellCheck={false}
        maxLength={LABEL_MAX + 8}
        enterKeyHint="done"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setError(null);
        }}
        onKeyDown={onKeyDown}
      />
      <div role="group" aria-label="Labels" className="loki-label-list">
        {matches.map((name) => {
          const on = labels.includes(name);
          return (
            <button
              key={name}
              type="button"
              role="checkbox"
              aria-checked={on}
              className="loki-label-option"
              disabled={!on && full}
              onClick={() => toggle(name)}
            >
              <span aria-hidden className="loki-label-dot" style={{ "--label-tone": labelColor(name, list) } as CSSProperties} />
              <span className="loki-label-option-name">{name}</span>
              {on && <Icon name="check" size={14} className="loki-label-check" />}
            </button>
          );
        })}
        {canCreate && typed && (
          <button type="button" className="loki-label-option" disabled={full} onClick={() => (toggle(typed), setQuery(""))}>
            <Icon name="plus" size={14} />
            <span>
              Create <strong>{typed}</strong>
            </span>
          </button>
        )}
        {!matches.length && !canCreate && <p className="loki-label-empty">{q ? "No label matches" : "No labels yet: type one to make it"}</p>}
      </div>
      {full && <p className="loki-label-empty">A chat holds {LABELS_PER_CHAT} labels at most.</p>}
      {error && (
        <p role="alert" className="loki-label-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function LabelsDialog({
  title,
  current,
  list,
  onChange,
  onClose,
}: {
  title: string;
  current: readonly string[];
  list: readonly LabelView[] | null;
  onChange: (labels: string[]) => Promise<string | null>;
  onClose: () => void;
}) {
  const sheet = (
    <Sheet label="Labels" onClose={onClose} width={400} top="16vh">
      <div className="loki-labels-dialog">
        <div className="loki-labels-dialog-title">Labels</div>
        <div className="loki-labels-dialog-chat">{title}</div>
        <LabelEditor current={current} list={list} onChange={onChange} />
        <div className="loki-labels-dialog-foot">
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Sheet>
  );
  return typeof document === "undefined" ? sheet : createPortal(sheet, document.body);
}

export function labelCommand(
  args: string,
  current: readonly string[],
  save: (labels: string[]) => Promise<string | null>,
  open?: () => void,
): Promise<string | null> {
  const name = labelName(args);
  if (!name) {
    open?.();
    return Promise.resolve(open ? null : "name a label: /label infra");
  }
  if (current.includes(name)) return Promise.resolve(null);
  if (current.length >= LABELS_PER_CHAT) return Promise.resolve(`a chat holds ${LABELS_PER_CHAT} labels at most`);
  return save(chatLabels([...current, name]));
}
