import { useState, type CSSProperties } from "react";
import { Button, Field } from "../components";
import { labelColor, paletteColor } from "../chat/labels";
import { keyFor } from "../shell/keymap";
import { LABEL_COLORS, LABEL_MAX, labelName, type LabelView } from "../../../core/labels.ts";
import { Block, Setting } from "./layout";

/** What Preferences › Labels asks of use-attention's labels: the list, and a rename, recolour or delete (an error, or null). */
export interface LabelsApi {
  list: LabelView[] | null;
  edit: (change: { name: string; rename?: string; color?: number } | { name: string; remove: true }) => Promise<string | null>;
}

/** What one row is doing: showing, renaming, choosing a colour, or asking before a delete. */
type RowMode = "show" | "rename" | "color" | "remove";

/**
 * Preferences › Labels (plan 022, R6): every label on a chat with its colour and how many chats carry it. Rename and
 * delete reach every chat that carries the label; a delete asks first, naming how many. The list loads with the link.
 */
export function Labels({ api }: { api: LabelsApi }) {
  const [error, setError] = useState<string | null>(null);
  if (!api.list) return <Setting label="Labels" help="asking loki…" />;
  return (
    <Block
      help={`labels gather related chats across agents. Add them from a chat's row, its header, or /label in the message box; find a label's chats with label:name in the sidebar's filter or ${keyFor("search.open")}.`}
    >
      {error && (
        <div role="alert" className="loki-meta loki-meta--negative loki-meta--wrap">
          {error}
        </div>
      )}
      {api.list.length === 0 ? (
        <Setting label="None yet" help="Label a chat and it shows here." />
      ) : (
        api.list.map((l) => <LabelRow key={l.name} label={l} list={api.list} api={api} onError={setError} />)
      )}
    </Block>
  );
}

/** One label: its dot, name and count, and rename, colour and delete. */
function LabelRow({ label, list, api, onError }: { label: LabelView; list: LabelView[] | null; api: LabelsApi; onError: (e: string | null) => void }) {
  const [mode, setMode] = useState<RowMode>("show");
  const [name, setName] = useState(label.name);
  const [busy, setBusy] = useState(false);
  const run = async (change: Parameters<LabelsApi["edit"]>[0]) => {
    setBusy(true);
    try {
      const err = await api.edit(change);
      onError(err);
      if (!err) setMode("show");
    } finally {
      setBusy(false);
    }
  };
  const renamed = labelName(name);
  const chats = `${label.chats} ${label.chats === 1 ? "chat" : "chats"}`;
  return (
    <div role="group" aria-label={`${label.name}, ${chats}`} style={{ display: "grid", gap: 8, padding: "12px 0" }}>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", alignItems: "center", gap: 10 }}>
        <span aria-hidden className="loki-label-dot" style={{ "--label-tone": labelColor(label.name, list) } as CSSProperties} />
        <span style={{ minWidth: 0 }}>
          <strong>{label.name}</strong>
          <span className="loki-meta" style={{ marginLeft: 8 }}>
            {chats}
          </span>
        </span>
        <span style={{ display: "flex", gap: 6 }}>
          <Button size="sm" onClick={() => (setName(label.name), setMode(mode === "rename" ? "show" : "rename"))} aria-label={`rename ${label.name}`}>
            rename
          </Button>
          <Button size="sm" onClick={() => setMode(mode === "color" ? "show" : "color")} aria-label={`colour of ${label.name}`}>
            colour
          </Button>
          <Button size="sm" tone="negative" onClick={() => setMode(mode === "remove" ? "show" : "remove")} aria-label={`delete ${label.name}`}>
            delete
          </Button>
        </span>
      </div>
      {mode === "rename" && (
        <form
          style={{ display: "flex", gap: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (renamed && renamed !== label.name) void run({ name: label.name, rename: renamed });
          }}
        >
          <Field
            size="sm"
            name="label-name"
            aria-label={`new name for ${label.name}`}
            autoComplete="off"
            spellCheck={false}
            maxLength={LABEL_MAX + 8}
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ flex: 1 }}
          />
          <Button size="sm" tone="positive" type="submit" disabled={busy || !renamed || renamed === label.name}>
            {busy ? "saving…" : renamed && renamed !== name.trim() ? `save as ${renamed}` : "save"}
          </Button>
        </form>
      )}
      {mode === "color" && (
        <div role="radiogroup" aria-label={`colour of ${label.name}`} style={{ display: "flex", gap: 6 }}>
          {Array.from({ length: LABEL_COLORS }, (_, color) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={color === label.color}
              aria-label={`colour ${color + 1}`}
              className="loki-label-swatch"
              style={{ "--label-tone": paletteColor(color) } as CSSProperties}
              disabled={busy}
              onClick={() => void run({ name: label.name, color })}
            />
          ))}
        </div>
      )}
      {mode === "remove" && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="loki-meta loki-meta--wrap">
            Take {label.name} off {chats}? The chats stay.
          </span>
          <Button size="sm" tone="negative" disabled={busy} onClick={() => void run({ name: label.name, remove: true })}>
            {busy ? "deleting…" : "delete"}
          </Button>
          <Button size="sm" onClick={() => setMode("show")}>
            cancel
          </Button>
        </div>
      )}
    </div>
  );
}
