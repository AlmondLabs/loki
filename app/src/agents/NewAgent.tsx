import { useEffect, useState } from "react";
import { PERSONALITIES, type Personality } from "../../../packages/core/src/attention/protocol.ts";
import { Button, Field, Row, Title } from "../components";

/** The form for a new agent: name, description, one of Letta's personality presets, a model. */
export function NewAgent({ models, onLoadModels, onCreate, onCancel, canCancel }: { models: string[] | null; onLoadModels: () => void; onCreate: (opts: { personality: Personality; name: string; description?: string; model?: string }) => Promise<string | null>; onCancel: () => void; canCancel: boolean }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [personality, setPersonality] = useState<Personality>("memo");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(onLoadModels, []); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const err = await onCreate({ personality, name: name.trim(), description: description.trim() || undefined, model: model.trim() || undefined });
      if (err) setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "24px 28px" }} onKeyDown={(e) => e.key === "Enter" && void submit()}>
      <div style={{ maxWidth: 560, display: "grid", gap: 12 }}>
        <Title>a new agent</Title>
        <Labelled label="name"><Field autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="ira, friday, atlas…" autoComplete="off" data-1p-ignore data-form-type="other" /></Labelled>
        <Labelled label="description"><Field value={description} onChange={(e) => setDescription(e.target.value)} placeholder="what this agent is for (optional)" autoComplete="off" data-form-type="other" /></Labelled>
        <Labelled label="personality">
          <div role="radiogroup" style={{ display: "grid", gap: 4, width: "100%" }}>
            {PERSONALITIES.map((p) => (
              <Row dense key={p.id} role="radio" aria-checked={personality === p.id} selected={personality === p.id} onClick={() => setPersonality(p.id)} style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 10 }}>
                <span style={{ fontSize: 13.5 }}>{p.label}</span>
                <span style={{ fontSize: 12, color: "var(--loki-muted)" }}>{p.description}</span>
              </Row>
            ))}
          </div>
        </Labelled>
        <Labelled label="model">
          <Field mono list="loki-new-agent-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder={models?.length ? "the harness default, or pick one" : "the harness default"} autoComplete="off" data-form-type="other" />
          <datalist id="loki-new-agent-models">{(models ?? []).map((m) => <option key={m} value={m} />)}</datalist>
        </Labelled>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {error && <span style={{ fontSize: 12, color: "var(--loki-negative)", fontFamily: "var(--loki-mono)" }}>{error}</span>}
          <span style={{ flex: 1 }} />
          {canCancel && <Button onClick={onCancel}>cancel</Button>}
          <Button tone="brass" onClick={() => void submit()} disabled={busy || !name.trim()} kbd="↵">{busy ? "creating…" : "create"}</Button>
        </div>
      </div>
    </div>
  );
}

/** A labelled line in the new-agent form: the label in the head's voice, the control beside it. */
function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 8px" }}>
      <span className="loki-label" style={{ fontSize: 9.5, width: 44 }}>{label}</span>
      {children}
    </div>
  );
}
