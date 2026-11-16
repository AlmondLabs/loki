import { useEffect, useEffectEvent, useState } from "react";
import type { PassSettings } from "../../../core/attention/protocol.ts";

import { Chip, Meta } from "../components";
import { ago } from "../shared/ago";
import { Pane } from "./bits";
import { CommitView, passAuthor } from "./changes-page";
import type { AgentsApi, ReflectionControls } from "./types";
import type { ReadingState } from "./use-reading";
import type { MemoryCommit, ReflectionState } from "../../../core/frame-types.ts";

export function reflectionRuns(log: readonly MemoryCommit[]): MemoryCommit[] {
  return log.filter((c) => passAuthor(c.author) === "reflection");
}

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
  const [settings, setSettings] = useState<PassSettings | null | undefined>(undefined);
  const [state, setState] = useState<ReflectionState | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);

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
  const toggleAcp = async (enabled: boolean) => {
    if (!settings) return;
    const err = await reflect.set({ acp: { enabled } });
    if (err) setNotice(err);
    else setSettings({ ...settings, acp: { enabled } });
  };

  return (
    <Pane>
      <div className="grid gap-4" style={{ maxWidth: 760, marginBottom: 24 }}>
        <div className="loki-label">Reflection</div>
        {settings === undefined ? (
          <Meta>Reading the settings…</Meta>
        ) : settings === null ? (
          <Meta wrap>loki's daemon did not answer for this setting — it has to be running.</Meta>
        ) : (
          <span className="inline-flex gap-2">
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
          <span className="inline-flex gap-2">
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
