import { useEffect, useRef, useState } from "react";
import { LAYER } from "../kit/layers";
import { btn, kbd } from "../chat/ui";
import { PRIORITY_LABEL } from "./model";

/**
 * ⌘J anywhere: file a task yourself, no agent turn. A title, an optional description
 * and labels, a priority. Enter files it and closes; ⇧Enter is a newline in the description.
 */
export function TaskCapture({
  open,
  onClose,
  onCreate,
  context,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (t: { title: string; description?: string; labels?: string[]; priority: number }) => Promise<string | null>;
  /** Where the note is being taken; shown so you know what it will be stamped with. */
  context: { desk: string | null; agentName: string | null };
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [labels, setLabels] = useState("");
  const [priority, setPriority] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setDescription("");
    setLabels("");
    setPriority(2);
    setError(null);
    setTimeout(() => titleRef.current?.focus(), 0);
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    const err = await onCreate({ title: title.trim(), description: description.trim() || undefined, labels: labels.split(",").map((l) => l.trim()).filter(Boolean), priority });
    setBusy(false);
    if (err) setError(err);
    else onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      style={{ position: "absolute", inset: 0, background: "var(--loki-veil)", display: "grid", placeItems: "start center", paddingTop: "14vh", zIndex: LAYER.modal + 1 }}
    >
      <div role="dialog" aria-label="new task" onKeyDown={onKey} style={{ width: 560, maxWidth: "92vw", background: "var(--loki-panel)", border: "1px solid var(--loki-border)", borderRadius: 12, boxShadow: "var(--loki-shadow-sheet)", overflow: "hidden" }}>
        <input
          ref={titleRef}
          type="search"
          name="task-title"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="task for later… (one line, imperative)"
          aria-label="task title"
          style={{ width: "100%", boxSizing: "border-box", padding: "13px 16px", fontSize: 15, fontFamily: "var(--loki-display)", background: "transparent", border: "none", borderBottom: "1px solid var(--loki-border)", color: "var(--loki-fg)", outline: "none" }}
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="why, and where to look (optional · shift+enter for a new line)"
          aria-label="task description"
          rows={3}
          style={{ width: "100%", boxSizing: "border-box", padding: "10px 16px", fontSize: 13.5, lineHeight: 1.5, background: "transparent", border: "none", borderBottom: "1px solid var(--loki-border)", color: "var(--loki-fg)", outline: "none", resize: "none", fontFamily: "inherit" }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px" }}>
          <input
            type="search"
            name="task-labels"
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            value={labels}
            onChange={(e) => setLabels(e.target.value)}
            placeholder="labels, comma separated"
            aria-label="labels"
            style={{ flex: 1, padding: "6px 10px", fontSize: 12, background: "var(--loki-bg)", border: "1px solid var(--loki-border)", borderRadius: 6, color: "var(--loki-fg)", outline: "none" }}
          />
          <span style={{ display: "inline-flex", gap: 4 }} role="radiogroup" aria-label="priority">
            {PRIORITY_LABEL.map((p, i) => (
              <button key={p} type="button" role="radio" aria-checked={priority === i} onClick={() => setPriority(i)} className="loki-label" style={{ padding: "4px 7px", fontSize: 9.5, border: `1px solid ${priority === i ? "var(--loki-accent)" : "var(--loki-border)"}`, background: priority === i ? "var(--loki-brass-soft)" : "transparent", color: priority === i ? "var(--loki-accent)" : "var(--loki-muted)", cursor: "pointer" }}>
                {p}
              </button>
            ))}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 16px 12px", fontSize: 10.5, color: "var(--loki-muted)" }}>
          <span>
            filed by you{context.desk ? ` · from ${context.desk === "shared" ? "the shared desk" : `desk ${context.desk}`}` : ""}
            {context.agentName ? ` · ${context.agentName}'s thread` : ""}
          </span>
          {error && <span style={{ color: "var(--loki-negative)", fontFamily: "var(--loki-mono)" }}>{error}</span>}
          <span style={{ flex: 1 }} />
          <button type="button" onClick={onClose} style={btn()}>cancel <kbd style={kbd}>esc</kbd></button>
          <button type="button" onClick={() => void submit()} disabled={!title.trim() || busy} style={{ ...btn("var(--loki-accent)"), opacity: title.trim() && !busy ? 1 : 0.5 }}>
            {busy ? "filing…" : "file"} <kbd style={kbd}>↵</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
