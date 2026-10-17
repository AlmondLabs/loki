import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Button, Field, Sheet } from "../components";
import { Icon } from "../shared/icons";
import { LABELS_PER_CHAT, LABEL_COLORS, LABEL_MAX, chatLabels, labelName, type LabelView } from "../../../core/labels.ts";

/** The palette, in core/labels.ts's order: a label's colour index picks one (tokens.css, `--loki-label-*`). */
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

/** One colour of the palette by its index, for Settings › labels' swatches. */
export const paletteColor = (index: number): string => LABEL_COLOR_VARS[index % LABEL_COLORS];

/**
 * A label's colour: the one the daemon gave it (Settings › labels can change it), else one picked from its name
 * until the list arrives, so a chip never shows uncoloured.
 */
export function labelColor(name: string, list: readonly LabelView[] | null): string {
  const known = list?.find((l) => l.name === name)?.color;
  if (known !== undefined) return LABEL_COLOR_VARS[known % LABEL_COLORS];
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return LABEL_COLOR_VARS[hash % LABEL_COLORS];
}

/**
 * A chat's labels as chips: each its colour's dot and its name, on a faint tint of the colour. `max` shows that
 * many and then "+N"; `onPick` makes each a button (the header, where a click filters the sidebar). `dots` draws
 * only the colours, names in the tooltip (a sidebar row, where the title needs the room).
 */
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
          <button key={name} type="button" className="loki-label-chip" style={style} onClick={() => onPick(name)} title={`show the chats labelled ${name}`}>
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

/**
 * The labels… picker's body (plan 022, R1), the same in the desktop's dialog and the phone's sheet: a field that
 * finds a label or names a new one, then the labels as a checklist (the chat's own first) and a row to create the
 * typed one. Enter takes the first match, or creates the label when none matches; each tick saves at once. A chat holds at most LABELS_PER_CHAT.
 */
export function LabelEditor({
  current,
  list,
  touch = false,
  onChange,
}: {
  current: readonly string[];
  list: readonly LabelView[] | null;
  touch?: boolean;
  /** Save the chat's labels (the whole list); resolves to the daemon's error, or null when it took. */
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
    const err = await onChange(next).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
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
    // A label that matches wins; a new one is made only when nothing does (its row still makes one on a click).
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

/**
 * The desktop's labels… dialog for one chat, over the window (as Rename chat is): the editor, and Done. Mounted only
 * while open; the Sheet puts focus back where it was.
 */
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

/**
 * `/label` typed in a chat's box (plan 022, R1): `/label Client X` adds `client-x` to the chat's labels, creating it
 * if it is new; `/label` alone opens the picker, where there is one. Resolves to the daemon's error, or null.
 */
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
