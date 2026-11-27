import { useEffect, useEffectEvent, useState } from "react";
import type { PassSettings } from "../../../core/attention/protocol.ts";
import { Meta, Switch, notify } from "../components";
import type { ReflectionControls } from "../agents/types";
import { READING, answered, type Fetched } from "../shared/fetched";
import { Block, Segmented, Setting } from "./layout";

type FallbackChoice = "acp" | "wait";

export function ReflectionSettings({ reflect }: { reflect: ReflectionControls }) {
  const [settings, setSettings] = useState<Fetched<PassSettings>>(READING);
  const [error, setError] = useState<string | null>(null);

  const read = useEffectEvent(() => reflect.get());
  useEffect(() => {
    let live = true;
    void read().then((s) => live && setSettings(answered(s)));
    return () => {
      live = false;
    };
  }, []);

  if (settings.kind === "reading") {
    return (
      <Block
        title="Memory reflection"
        help="Quiet chats are reviewed in the background so recurring facts and preferences stay in memory, or run /reflect in any chat."
      >
        <Setting label="Automatic reflection" help="Reading the settings…" />
      </Block>
    );
  }
  if (settings.kind === "unanswered") {
    return (
      <Block
        title="Memory reflection"
        help="Quiet chats are reviewed in the background so recurring facts and preferences stay in memory, or run /reflect in any chat."
      >
        <Setting label="Automatic reflection" help="loki's daemon did not answer for this setting — it has to be running." />
      </Block>
    );
  }

  const toggleReflection = async () => {
    const next = !settings.value.reflection.enabled;
    const err = await reflect.set({ reflection: { enabled: next } });
    if (err) {
      setError(err);
      void notify(err);
    } else {
      setError(null);
      setSettings({ kind: "read", value: { ...settings.value, reflection: { enabled: next } } });
    }
  };

  const pickFallback = async (choice: FallbackChoice) => {
    const next = choice === "acp";
    const err = await reflect.set({ acp: { enabled: next } });
    if (err) {
      setError(err);
      void notify(err);
    } else {
      setError(null);
      setSettings({ kind: "read", value: { ...settings.value, acp: { enabled: next } } });
    }
  };

  return (
    <>
      <Block
        title="Memory reflection"
        help="Quiet chats are reviewed in the background so recurring facts and preferences stay in memory, or run /reflect in any chat."
      >
        <Setting label="Automatic reflection" help="Runs for every agent after chats stay quiet for half an hour, at most every two hours.">
          <Switch on={settings.value.reflection.enabled} onToggle={() => void toggleReflection()} label="Automatic reflection" hideLabel />
        </Setting>
      </Block>
      <Block title="Without a provider" help="Used when an agent's model has no connected provider in loki for reflection, Learn and /doctor.">
        <Setting
          label="Fallback engine"
          help="Runs background passes on the agent's latest Claude Code or Cursor chat, or waits until a provider is connected."
        >
          <Segmented<FallbackChoice>
            label="Without a provider"
            options={["acp", "wait"]}
            value={settings.value.acp.enabled ? "acp" : "wait"}
            onPick={(v) => void pickFallback(v)}
            labels={{ acp: "Claude Code or Cursor", wait: "Wait" }}
          />
        </Setting>
      </Block>
      {error && (
        <Meta negative wrap>
          {error}
        </Meta>
      )}
    </>
  );
}
