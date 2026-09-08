import { useEffect, useRef, useState } from "react";
import { LAYER } from "../kit/layers";
import { Button, Chip, Field, Sheet, TextArea } from "../ui";
import { PRIORITY_LABEL } from "./model";

/**
 * ⌘J anywhere: file a task yourself, no agent turn. A title, an optional description
 * and labels, a priority. Enter files it and closes; ⇧Enter is a newline in the description.
 */
export function TaskCapture({ open, ...props }: CaptureProps & { open: boolean }) {
  // The form mounts with the sheet and goes with it, so every ⌘J starts blank with the title focused.
  if (!open) return null;
  return <CaptureForm {...props} />;
}

interface CaptureProps {
  onClose: () => void;
  onCreate: (t: { title: string; description?: string; labels?: string[]; priority: number }) => Promise<string | null>;
  /** Where the note is being taken; shown so you know what it will be stamped with. */
  context: { desk: string | null; agentName: string | null };
}

function CaptureForm({ onClose, onCreate, context }: CaptureProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [labels, setLabels] = useState("");
  const [priority, setPriority] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => titleRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const err = await onCreate({ title: title.trim(), description: description.trim() || undefined, labels: labels.split(",").map((l) => l.trim()).filter(Boolean), priority });
      if (err) setError(err);
      else onClose();
    } finally {
      setBusy(false);
    }
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
    // The card's onKey owns Escape (and Enter), so the sheet's own Escape is off; the veil click still closes.
    <Sheet label="new task" onClose={onClose} width={560} top="14vh" zIndex={LAYER.capture} escape={false} cardProps={{ onKeyDown: onKey }}>
      <Field
        bare
        large
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
      />
      <TextArea
        bare
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="why, and where to look (optional · ⇧↵ for a new line)"
        aria-label="task description"
        rows={3}
        style={{ lineHeight: 1.5 }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px" }}>
        <Field
          size="sm"
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
          style={{ flex: 1 }}
        />
        <span style={{ display: "inline-flex", gap: 4 }} role="radiogroup" aria-label="priority">
          {PRIORITY_LABEL.map((p, i) => (
            <Chip key={p} label role="radio" aria-checked={priority === i} active={priority === i} onClick={() => setPriority(i)}>
              {p}
            </Chip>
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
        <Button size="sm" kbd="esc" onClick={onClose}>cancel</Button>
        <Button size="sm" tone="brass" kbd="↵" onClick={() => void submit()} disabled={!title.trim() || busy}>
          {busy ? "filing…" : "file"}
        </Button>
      </div>
    </Sheet>
  );
}
