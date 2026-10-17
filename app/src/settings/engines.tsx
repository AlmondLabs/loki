import { useEffect, useEffectEvent, useId, useState } from "react";
import { Button, Dot, Field, TextArea } from "../components";
import type { EnginesView, EngineView } from "../../../core/frame-types.ts";

/** What Settings › Engines asks of the daemon; each call resolves to the agents as they now stand, or an error message. */
export interface EnginesApi {
  get: () => Promise<EnginesView | string>;
  set: (engine: { id: string; name: string; command: string; args: string[] }) => Promise<EnginesView | string>;
  remove: (id: string) => Promise<EnginesView | string>;
  check: (id: string) => Promise<EnginesView | string>;
}

const TONE: Record<EngineView["status"], string> = {
  ready: "var(--loki-positive)",
  started: "var(--loki-positive)",
  unknown: "var(--loki-muted)",
  not_found: "var(--loki-negative)",
  signed_out: "var(--loki-accent)",
  failed: "var(--loki-negative)",
};

/** A status as the list says it. */
const WORDS: Record<EngineView["status"], string> = {
  ready: "ready",
  started: "starts",
  unknown: "not tried yet",
  not_found: "not found",
  signed_out: "needs signing in",
  failed: "failed",
};

/** A name as an agent id: lowercase letters, digits and dashes ("Gemini CLI" → "gemini-cli"). */
export const engineId = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Settings › Engines (plan 020, R10): the ACP agents a chat can run on, Claude Code first, each with how it stands
 * (its command found, signed in, its last failure). Try starts one now; add and edit write ~/.loki/state/acp.json.
 */
export function Engines({ api }: { api: EnginesApi }) {
  const [view, setView] = useState<EnginesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EngineView | "new" | null>(null);
  const [trying, setTrying] = useState<string | null>(null);
  const apply = (r: EnginesView | string) => {
    if (typeof r === "string") return setError(r);
    setError(null);
    setView(r);
  };
  const read = useEffectEvent(() => api.get());
  useEffect(() => {
    let live = true;
    void read().then((r) => live && apply(r));
    return () => {
      live = false;
    };
  }, []);
  const tryOne = async (id: string) => {
    setTrying(id);
    apply(await api.check(id));
    setTrying(null);
  };

  if (!view) return <div className="loki-meta loki-meta--wrap">{error ?? "asking loki…"}</div>;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="loki-meta loki-meta--wrap">
        A chat picks its engine in the model picker before its first message. Claude Code runs signed in as you, through npx; others are added by the command
        that starts them. Your own are kept in <span style={{ fontFamily: "var(--loki-mono)" }}>{view.config_path}</span>.
      </div>
      {error && <div className="loki-meta loki-meta--negative loki-meta--wrap">{error}</div>}
      <div style={{ display: "grid", gap: 2 }}>
        {view.engines.map((e) => (
          // Not a Row: a row is a button, and this one holds buttons of its own.
          <div
            key={e.id}
            role="group"
            aria-label={`${e.name}, ${WORDS[e.status]}`}
            style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", alignItems: "center", gap: 10, padding: "6px 8px" }}
          >
            <Dot color={TONE[e.status]} />
            <span style={{ minWidth: 0 }}>
              <strong>{e.name}</strong>
              <span className="loki-meta" style={{ marginLeft: 8 }}>
                {WORDS[e.status]}
                {e.builtin ? (e.changed ? " · started your way" : " · built in") : ""}
              </span>
              <span className="loki-meta loki-meta--wrap" style={{ display: "block", fontFamily: "var(--loki-mono)", overflowWrap: "anywhere" }}>
                {[e.command, ...e.args].join(" ")}
              </span>
              {e.detail && (
                <span
                  className={`loki-meta loki-meta--wrap${e.status === "failed" || e.status === "not_found" ? " loki-meta--negative" : ""}`}
                  style={{ display: "block" }}
                >
                  {e.detail}
                </span>
              )}
            </span>
            <span style={{ display: "flex", gap: 6 }}>
              <Button size="sm" onClick={() => void tryOne(e.id)} disabled={trying !== null} aria-label={`try starting ${e.name}`}>
                {trying === e.id ? "starting…" : "try"}
              </Button>
              <Button size="sm" onClick={() => setEditing(e)} aria-label={`edit ${e.name}`}>
                edit
              </Button>
              {(!e.builtin || e.changed) && (
                <Button
                  size="sm"
                  tone="negative"
                  onClick={() => void api.remove(e.id).then(apply)}
                  aria-label={e.builtin ? `start ${e.name} as loki ships it` : `remove ${e.name}`}
                >
                  {e.builtin ? "reset" : "remove"}
                </Button>
              )}
            </span>
          </div>
        ))}
      </div>
      {editing ? (
        <EngineForm
          key={editing === "new" ? "new" : editing.id}
          engine={editing === "new" ? null : editing}
          api={api}
          onDone={(r) => {
            if (r) apply(r);
            setEditing(null);
          }}
        />
      ) : (
        <Button size="sm" tone="brass" onClick={() => setEditing("new")} style={{ justifySelf: "start" }}>
          + add an agent
        </Button>
      )}
    </div>
  );
}

/** Add an ACP agent, or change how one starts: its name, its command and its arguments, one per line. */
function EngineForm({ engine, api, onDone }: { engine: EngineView | null; api: EnginesApi; onDone: (r: EnginesView | null) => void }) {
  const uid = useId();
  const [name, setName] = useState(engine?.name ?? "");
  const [command, setCommand] = useState(engine?.command ?? "");
  const [args, setArgs] = useState(() => (engine?.args ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const id = engine?.id ?? engineId(name);
    if (!id) return setError("give the agent a name");
    if (!command.trim()) return setError("say which command starts it");
    setBusy(true);
    try {
      const r = await api.set({
        id,
        name: name.trim(),
        command: command.trim(),
        args: args
          .split("\n")
          .map((a) => a.trim())
          .filter(Boolean),
      });
      if (typeof r === "string") setError(r);
      else onDone(r);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: "grid", gap: 8, padding: 12, border: "1px solid var(--loki-border)", borderRadius: "var(--loki-radius-lg)" }}>
      <strong>{engine ? `Edit ${engine.name}` : "Add an agent"}</strong>
      <label htmlFor={`${uid}-name`} className="loki-label">
        Name
      </label>
      <Field id={`${uid}-name`} size="sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="Gemini CLI" />
      <label htmlFor={`${uid}-command`} className="loki-label">
        Command
      </label>
      <Field id={`${uid}-command`} size="sm" mono value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" spellCheck={false} />
      <label htmlFor={`${uid}-args`} className="loki-label">
        Arguments, one per line
      </label>
      <TextArea
        id={`${uid}-args`}
        size="sm"
        mono
        rows={3}
        value={args}
        onChange={(e) => setArgs(e.target.value)}
        placeholder={"-y\n@google/gemini-cli\n--experimental-acp"}
        spellCheck={false}
      />
      {error && <div className="loki-meta loki-meta--negative loki-meta--wrap">{error}</div>}
      <div style={{ display: "flex", gap: 6 }}>
        <Button size="sm" tone="brass" onClick={() => void save()} disabled={busy}>
          {busy ? "saving…" : "save"}
        </Button>
        <Button size="sm" onClick={() => onDone(null)}>
          cancel
        </Button>
      </div>
    </div>
  );
}
