import { useEffect, useEffectEvent, useState } from "react";
import type { NewAgentOptions } from "../../../core/attention/chat-client.ts";
import { Button, Field, TextArea } from "../components";
import { formatKeys } from "../shell/keymap";

/** What the persona box says before anything is typed: what goes there, and where it ends up. */
export const PERSONA_HINT =
  "Who this agent is and how it works, in your words (optional) — it starts the agent's memory, system/persona.md, which the agent keeps up from there";

/** The form for a new agent: name, description, persona (in the person's own words), a model. */
export function NewAgent({
  models,
  onLoadModels,
  onCreate,
  onCancel,
  canCancel,
}: {
  models: string[] | null;
  onLoadModels: () => void;
  onCreate: (opts: NewAgentOptions) => Promise<string | null>;
  onCancel: () => void;
  canCancel: boolean;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [persona, setPersona] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadModels = useEffectEvent(onLoadModels);
  useEffect(() => loadModels(), []);
  const submit = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const err = await onCreate({
        name: name.trim(),
        description: description.trim() || undefined,
        persona: persona.trim() || undefined,
        model: model.trim() || undefined,
      });
      if (err) setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="flex-1"
      style={{ minHeight: 0, overflowY: "auto", padding: "24px 20px" }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLElement).tagName !== "TEXTAREA" && void submit()}
    >
      <div className="grid gap-4" style={{ maxWidth: 640 }}>
        <Labelled label="Name">
          <Field
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="atlas, scout, sage…"
            autoComplete="off"
            data-1p-ignore
            data-form-type="other"
          />
        </Labelled>
        <Labelled label="Description">
          <Field
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this agent is for (optional)"
            autoComplete="off"
            data-form-type="other"
          />
        </Labelled>
        <Labelled label="Persona">
          <TextArea rows={5} value={persona} onChange={(e) => setPersona(e.target.value)} placeholder={PERSONA_HINT} data-form-type="other" />
        </Labelled>
        <Labelled label="Model">
          <Field
            list="loki-new-agent-models"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={models?.length ? "The harness default, or pick one" : "The harness default"}
            autoComplete="off"
            data-form-type="other"
          />
          <datalist id="loki-new-agent-models">
            {(models ?? []).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Labelled>
        <Labelled label="">
          <div className="flex items-center gap-2">
            {error && <span className="loki-meta loki-meta--negative loki-meta--wrap">{error}</span>}
            <span className="flex-1" />
            {canCancel && <Button onClick={onCancel}>Cancel</Button>}
            <Button tone="positive" onClick={() => void submit()} disabled={busy || !name.trim()} kbd={formatKeys("enter")}>
              {busy ? "Creating…" : "Create Agent"}
            </Button>
          </div>
        </Labelled>
      </div>
    </div>
  );
}

/**
 * A labelled line in the new-agent form: one label column wide enough for the longest label, so every control starts
 * at the same edge; the label sits level with the control's first line (a list's label at its top, not its middle).
 */
function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] items-start gap-x-4" style={{ padding: "0 8px" }}>
      <span className="loki-label" style={{ paddingTop: 8, lineHeight: "18px" }}>
        {label}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
