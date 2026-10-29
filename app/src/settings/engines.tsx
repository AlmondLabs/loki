import { useEffect, useEffectEvent, useId, useState } from "react";
import { Button, Dot, Field, TextArea, sentence } from "../components";
import { Block, Setting } from "./layout";
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
 * Settings › Engines (plan 020, R10): the ACP agents a chat can run on, the built-in ones first, each with how it stands
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

  if (!view) return <Setting label="Engines" help={error ?? "asking loki…"} />;
  return (
    <>
      <Block help="what a chat can run on besides loki's own models. A chat picks its engine in the model picker, before its first message.">
        {error && <div className="loki-meta loki-meta--negative loki-meta--wrap">{error}</div>}
        {view.engines.map((e) => (
          <EngineRow
            key={e.id}
            e={e}
            trying={trying}
            onTry={() => void tryOne(e.id)}
            onEdit={() => setEditing(e)}
            onRemove={() => void api.remove(e.id).then(apply)}
          />
        ))}
      </Block>
      <Block title={editing && editing !== "new" ? `Edit ${editing.name}` : "Add an engine"}>
        {editing ? (
          <EngineForm
            key={editing === "new" ? "new" : editing.id}
            engine={editing === "new" ? null : editing}
            configPath={view.config_path}
            api={api}
            onDone={(r) => {
              if (r) apply(r);
              setEditing(null);
            }}
          />
        ) : (
          <Setting label="Any agent that speaks ACP" help="Added by the command that starts it, such as Gemini CLI or Codex.">
            <Button tone="positive" onClick={() => setEditing("new")}>
              add an engine
            </Button>
          </Setting>
        )}
      </Block>
    </>
  );
}

/** One engine: its name and how it stands, the command that starts it behind "details", and try, edit and remove. */
function EngineRow({
  e,
  trying,
  onTry,
  onEdit,
  onRemove,
}: {
  e: EngineView;
  trying: string | null;
  onTry: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [details, setDetails] = useState(false);
  const bad = e.status === "failed" || e.status === "not_found";
  return (
    <div role="group" aria-label={`${e.name}, ${WORDS[e.status]}`}>
      <Setting
        label={e.name}
        help={
          <>
            <Dot color={TONE[e.status]} style={{ marginRight: 6, verticalAlign: "middle" }} />
            {sentence(WORDS[e.status])}
            {e.builtin ? (e.changed ? ", started your way" : ", built in") : ""}.
            {e.detail && (
              <span className={`loki-meta--wrap${bad ? " loki-meta--negative" : ""}`} style={{ display: "block" }}>
                {e.detail}
              </span>
            )}
          </>
        }
      >
        <Button size="sm" bare onClick={() => setDetails(!details)} aria-expanded={details}>
          details
        </Button>
        <Button size="sm" onClick={onTry} disabled={trying !== null} aria-label={`try starting ${e.name}`}>
          {trying === e.id ? "starting…" : "try"}
        </Button>
        <Button size="sm" onClick={onEdit} aria-label={`edit ${e.name}`}>
          edit
        </Button>
        {(!e.builtin || e.changed) && (
          <Button size="sm" tone="negative" onClick={onRemove} aria-label={e.builtin ? `start ${e.name} as loki ships it` : `remove ${e.name}`}>
            {e.builtin ? "reset" : "remove"}
          </Button>
        )}
      </Setting>
      {details && (
        <div className="loki-meta loki-meta--wrap" style={{ paddingBottom: 12, fontFamily: "var(--loki-mono)", overflowWrap: "anywhere" }}>
          {[e.command, ...e.args].join(" ")}
        </div>
      )}
    </div>
  );
}

/** Add an ACP agent, or change how one starts: its name, its command and its arguments, one per line. */
function EngineForm({
  engine,
  configPath,
  api,
  onDone,
}: {
  engine: EngineView | null;
  configPath: string;
  api: EnginesApi;
  onDone: (r: EnginesView | null) => void;
}) {
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
    <div style={{ display: "grid", gap: 8, padding: 12, marginTop: 10, border: "1px solid var(--loki-border)", borderRadius: "var(--loki-radius-lg)" }}>
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
        <Button size="sm" tone="positive" onClick={() => void save()} disabled={busy}>
          {busy ? "saving…" : "save"}
        </Button>
        <Button size="sm" onClick={() => onDone(null)}>
          cancel
        </Button>
      </div>
      <div className="loki-meta loki-meta--wrap">
        Kept in <span style={{ fontFamily: "var(--loki-mono)" }}>{configPath}</span>.
      </div>
    </div>
  );
}
