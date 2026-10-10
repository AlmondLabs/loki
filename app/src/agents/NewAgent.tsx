import { useEffect, useState } from "react";
import { PERSONALITIES, type Personality } from "../../../core/attention/protocol.ts";
import { Button, Field, Row } from "../components";
import { formatKeys } from "../shell/keymap";

/** The form for a new agent: name, description, a personality preset (core/attention/protocol.ts), a model. */
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
      <div style={{ maxWidth: 640, display: "grid", gap: 14 }}>
        <Labelled label="Name"><Field autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="ira, friday, atlas…" autoComplete="off" data-1p-ignore data-form-type="other" /></Labelled>
        <Labelled label="Description"><Field value={description} onChange={(e) => setDescription(e.target.value)} placeholder="what this agent is for (optional)" autoComplete="off" data-form-type="other" /></Labelled>
        <Labelled label="Personality">
          <div role="radiogroup" style={{ display: "grid", gap: 4, width: "100%" }}>
            {PERSONALITIES.map((p) => (
              <Row dense key={p.id} role="radio" aria-checked={personality === p.id} selected={personality === p.id} onClick={() => setPersonality(p.id)} style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 10 }}>
                <span style={{ fontSize: 13.5 }}>{p.label}</span>
                <span className="loki-meta loki-meta--wrap">{p.description}</span>
              </Row>
            ))}
          </div>
        </Labelled>
        <Labelled label="Model">
          <Field list="loki-new-agent-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder={models?.length ? "the harness default, or pick one" : "the harness default"} autoComplete="off" data-form-type="other" />
          <datalist id="loki-new-agent-models">{(models ?? []).map((m) => <option key={m} value={m} />)}</datalist>
        </Labelled>
        <Labelled label="">
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {error && <span className="loki-meta loki-meta--negative loki-meta--wrap">{error}</span>}
            <span style={{ flex: 1 }} />
            {canCancel && <Button onClick={onCancel}>Cancel</Button>}
            <Button tone="positive" onClick={() => void submit()} disabled={busy || !name.trim()} kbd={formatKeys("enter")}>{busy ? "Creating…" : "Create agent"}</Button>
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
    <div style={{ display: "grid", gridTemplateColumns: "96px minmax(0, 1fr)", alignItems: "start", columnGap: 16, padding: "0 8px" }}>
      <span className="loki-label" style={{ paddingTop: 9, lineHeight: "18px" }}>{label}</span>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}
