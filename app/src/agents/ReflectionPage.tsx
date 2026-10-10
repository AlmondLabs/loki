import { useEffect, useState } from "react";
import type { PassSettings } from "../../../core/attention/protocol.ts";

import { Chip, Meta } from "../components";
import { ago } from "../board/model";
import { Head, ListPane, Pane } from "./bits";
import type { AgentsApi, ReflectionControls } from "./types";
import type { ReflectionState } from "../../../core/frame-types.ts";

/**
 * The reflection page: whether loki keeps its agents' memory up to date in the background (daemon/passes.ts). Once
 * a chat has been quiet for half an hour, reflection reads what was said since it last read that chat, as the agent,
 * and keeps what will matter in later chats as memory commits by "Reflection"; it also reads a chat right after its
 * context is compacted. The switch is for every agent at once; /reflect in a chat starts a pass by hand.
 */
export function ReflectionPage({ agentId, agentName, api, reflect }: { agentId: string; agentName: string; api: AgentsApi; reflect: ReflectionControls }) {
  /** undefined: reading; null: the daemon did not answer. */
  const [settings, setSettings] = useState<PassSettings | null | undefined>(undefined);
  const [state, setState] = useState<ReflectionState | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);

  // Mounted per agent (Agents.tsx keys this page by the agent id), so the state above starts fresh with each tab.
  useEffect(() => {
    let gone = false;
    void api.reflection(agentId).then((s) => !gone && setState(s));
    void reflect.get().then((s) => !gone && setSettings(s));
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  const toggle = async (enabled: boolean) => {
    if (!settings) return;
    const err = await reflect.set({ reflection: { enabled } });
    if (err) setNotice(err);
    else setSettings({ ...settings, reflection: { enabled } });
  };

  return (
    <div style={{ minHeight: 0, display: "grid", gridTemplateColumns: "minmax(280px, 360px) 1fr" }}>
      <ListPane>
        <Head>Reflection</Head>
        <div style={{ display: "grid", gap: 14, padding: "4px 8px 0" }}>
          {settings === undefined ? (
            <Meta>reading the settings…</Meta>
          ) : settings === null ? (
            <Meta wrap>loki's daemon did not answer for this setting — it has to be running.</Meta>
          ) : (
            <span style={{ display: "inline-flex", gap: 6 }}>
              <Chip label active={settings.reflection.enabled} aria-pressed={settings.reflection.enabled} onClick={() => void toggle(true)}>
                on
              </Chip>
              <Chip label active={!settings.reflection.enabled} aria-pressed={!settings.reflection.enabled} onClick={() => void toggle(false)}>
                off
              </Chip>
            </span>
          )}
          {notice && <Meta wrap>{notice}</Meta>}
          <Meta wrap>For every agent: once a chat has been quiet for half an hour, the agent reads what was said since it last looked and keeps in memory what will matter in later chats. /reflect in a chat does it now.</Meta>
        </div>
      </ListPane>
      <Pane>
        <div className="loki-label" style={{ marginBottom: 12 }}>
          Last change
        </div>
        {state === undefined ? (
          <Meta>reading…</Meta>
        ) : state?.lastCommit ? (
          <Meta wrap>
            {ago(state.lastCommit.at)} · {state.lastCommit.message}
          </Meta>
        ) : (
          <Meta wrap>reflection has not changed {agentName}'s memory yet</Meta>
        )}
      </Pane>
    </div>
  );
}
