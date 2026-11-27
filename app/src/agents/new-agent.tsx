import { useEffect, useEffectEvent, useState } from "react";
import type { NewAgentOptions } from "../../../core/attention/chat-client.ts";
import type { ModelEntry } from "../../../core/models.ts";
import { Button, Field, Meta, Sheet, TextArea } from "../components";
import { formatKeys } from "../shell/keymap";
import { ModelSelect } from "./model-select";

export const PERSONA_HINT =
  "Who this agent is and how it works, in your words (optional) — it starts the agent's memory, system/persona.md, which the agent keeps up from there";

export function NewAgent({
  models,
  onLoadModels,
  onCreate,
  onCancel,
  canCancel,
}: {
  models: ModelEntry[] | null;
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
    const opts: NewAgentOptions = {
      name: name.trim(),
      description: description.trim() || undefined,
      persona: persona.trim() || undefined,
      model: model.trim() || undefined,
    };
    let err: string | null;
    try {
      err = await onCreate(opts);
    } catch (e) {
      setBusy(false);
      throw e;
    }
    setBusy(false);
    if (err) setError(err);
  };

  return (
    <Sheet label="New agent" onClose={canCancel ? onCancel : undefined} width={520} top="10vh" scroll>
      <div
        className="grid gap-4"
        style={{ padding: 20 }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLElement).tagName !== "TEXTAREA" && void submit()}
      >
        <div style={{ fontSize: "var(--text-base)", fontWeight: 700, color: "var(--loki-fg)" }}>New agent</div>
        <div className="grid gap-3">
          <FormField label="Name">
            <Field
              size="sm"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="atlas, scout, sage…"
              autoComplete="off"
              data-1p-ignore
              data-form-type="other"
            />
          </FormField>
          <FormField label="Description">
            <Field
              size="sm"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this agent is for (optional)"
              autoComplete="off"
              data-form-type="other"
            />
          </FormField>
          <FormField label="Persona">
            <TextArea size="sm" rows={4} value={persona} onChange={(e) => setPersona(e.target.value)} placeholder={PERSONA_HINT} data-form-type="other" />
          </FormField>
          <div className="flex items-center justify-between gap-4" style={{ paddingTop: 4 }}>
            <span className="loki-label">Model</span>
            <ModelSelect value={model} entries={models} onLoad={onLoadModels} onPick={setModel} allowDefault anchor="right" ariaLabel="Model" />
          </div>
        </div>
        <div className="flex items-center gap-2" style={{ paddingTop: 4 }}>
          {error && (
            <Meta role="alert" negative wrap>
              {error}
            </Meta>
          )}
          <span className="flex-1" />
          {canCancel && (
            <Button size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button size="sm" tone="positive" onClick={() => void submit()} disabled={busy || !name.trim()} kbd={formatKeys("enter")}>
            {busy ? "Creating…" : "Create Agent"}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1">
      <span className="loki-label">{label}</span>
      {children}
    </label>
  );
}
