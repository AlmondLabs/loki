import { useEffect, useEffectEvent, useState } from "react";
import type { PassSettings } from "../../../core/attention/protocol.ts";

import { Chip, Meta } from "../components";
import { ago } from "../shared/ago";
import { Pane } from "./bits";
import { CommitView, passAuthor } from "./changes-page";
import type { AgentsApi, ReflectionControls } from "./types";
import type { ReadingState } from "./use-reading";
import type { MemoryCommit, ReflectionState } from "../../../core/frame-types.ts";

/** Reflection's runs, the Reflection page's items (plan 2026-11-14-1330, KTD9): the memory commits a reflection pass made, newest first. */
export function reflectionRuns(log: readonly MemoryCommit[]): MemoryCommit[] {
  return log.filter((c) => passAuthor(c.author) === "reflection");
}

/**
 * The reflection page: whether loki keeps its agents' memory up to date in the background (daemon/passes.ts). Once
 * a chat has been quiet for half an hour, reflection reads what was said since it last read it (a batch of the agent's
 * quiet chats at once, daemon/passes.ts), as the agent,
 * and keeps what will matter in later chats as memory commits by "Reflection"; it also reads a chat right after its
 * context is compacted. The switch is for every agent at once; /reflect in a chat starts a pass by hand. Under the
 * settings, the run chosen in the list is read as a commit, or the last change reflection made when it has no run in
 * the latest changes.
 */
export function ReflectionPage({
  agentId,
  agentName,
  api,
  reflect,
  run,
  reading,
  onRevert,
}: {
  agentId: string;
  agentName: string;
  api: AgentsApi;
  reflect: ReflectionControls;
  run: MemoryCommit | null;
  reading: ReadingState;
  onRevert: (sha: string) => void;
}) {
  /** undefined: reading; null: the daemon did not answer. */
  const [settings, setSettings] = useState<PassSettings | null | undefined>(undefined);
  const [state, setState] = useState<ReflectionState | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);

  // Mounted per agent (agents.tsx keys this page by the agent id), so the state above starts fresh with each tab.
  const readState = useEffectEvent((id: string) => api.reflection(id));
  const readSettings = useEffectEvent(() => reflect.get());
  useEffect(() => {
    let gone = false;
    void readState(agentId).then((s) => !gone && setState(s));
    void readSettings().then((s) => !gone && setSettings(s));
    return () => {
      gone = true;
    };
  }, [agentId]);

  const toggle = async (enabled: boolean) => {
    if (!settings) return;
    const err = await reflect.set({ reflection: { enabled } });
    if (err) setNotice(err);
    else setSettings({ ...settings, reflection: { enabled } });
  };
  // Whether an agent with no model loki can reach runs its passes on its Claude Code or Cursor agent (plan 061).
  const toggleAcp = async (enabled: boolean) => {
    if (!settings) return;
    const err = await reflect.set({ acp: { enabled } });
    if (err) setNotice(err);
    else setSettings({ ...settings, acp: { enabled } });
  };

  return (
    <Pane>
      <div style={{ display: "grid", gap: 14, maxWidth: 760, marginBottom: 24 }}>
        <div className="loki-label">Reflection</div>
        {settings === undefined ? (
          <Meta>Reading the settings…</Meta>
        ) : settings === null ? (
          <Meta wrap>loki's daemon did not answer for this setting — it has to be running.</Meta>
        ) : (
          <span style={{ display: "inline-flex", gap: 6 }}>
            <Chip label active={settings.reflection.enabled} aria-pressed={settings.reflection.enabled} onClick={() => void toggle(true)}>
              On
            </Chip>
            <Chip label active={!settings.reflection.enabled} aria-pressed={!settings.reflection.enabled} onClick={() => void toggle(false)}>
              Off
            </Chip>
          </span>
        )}
        {notice && <Meta wrap>{notice}</Meta>}
        <Meta wrap>
          For every agent: once chats have been quiet for half an hour, the agent reads what was said in them since it last looked, several together and at most
          every two hours, and keeps in memory what will matter in later chats, what recurs across them most of all. /reflect in a chat does it now.
        </Meta>
        <div className="loki-label">Without a provider</div>
        {settings && (
          <span style={{ display: "inline-flex", gap: 6 }}>
            <Chip label active={settings.acp.enabled} aria-pressed={settings.acp.enabled} onClick={() => void toggleAcp(true)}>
              Use Claude Code or Cursor
            </Chip>
            <Chip label active={!settings.acp.enabled} aria-pressed={!settings.acp.enabled} onClick={() => void toggleAcp(false)}>
              Wait
            </Chip>
          </span>
        )}
        <Meta wrap>
          An agent whose model loki cannot reach, with no provider set up, runs reflection, Learn and /doctor on the agent its newest Claude Code or Cursor chat
          uses. Each run spends a little of that allowance. Set to Wait, they run only once a provider is set up.
        </Meta>
      </div>
      {run ? (
        <CommitView commit={run} reading={reading} onRevert={onRevert} />
      ) : (
        <>
          <div className="loki-label" style={{ marginBottom: 12 }}>
            Last change
          </div>
          {state === undefined ? (
            <Meta>Reading…</Meta>
          ) : state?.last_commit ? (
            <Meta wrap>
              {ago(state.last_commit.at)} · {state.last_commit.message}
            </Meta>
          ) : (
            <Meta wrap>Reflection has not changed {agentName}'s memory yet</Meta>
          )}
        </>
      )}
    </Pane>
  );
}
