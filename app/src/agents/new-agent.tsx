import { useEffect, useEffectEvent, useState } from "react";
import type { NewAgentOptions } from "../../../core/attention/chat-client.ts";
import { Button, Field, TextArea } from "../components";
import { formatKeys } from "../shell/keymap";

export const PERSONA_HINT =
  "Who this agent is and how it works, in your words (optional) — it starts the agent's memory, system/persona.md, which the agent keeps up from there";

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
            {error && (
              <span role="alert" className="loki-meta loki-meta--negative loki-meta--wrap">
                {error}
              </span>
            )}
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

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  const Line = label ? "label" : "div";
  return (
    <Line className="grid grid-cols-[96px_minmax(0,1fr)] items-start gap-x-4" style={{ padding: "0 8px" }}>
      <span className="loki-label" style={{ paddingTop: 8, lineHeight: "18px" }}>
        {label}
      </span>
      <span className="block min-w-0">{children}</span>
    </Line>
  );
}
