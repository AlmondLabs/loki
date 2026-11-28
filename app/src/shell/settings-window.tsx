import { useEffect, useState } from "react";
import { Notices, notify } from "../components";
import { inDesktop, settingsWindow } from "../workspace/env";
import { currentWindow, listen } from "./desktop";
import { useWorkspace } from "../workspace/use-workspace";
import { Settings } from "../settings/settings";
import { useDaemonStatus } from "./bootstrap";
import { MODELS_CHANGED_KEY } from "./open-settings";
import { useGlobalShortcut } from "./use-global-shortcut";
import { useLokiUpdate } from "./use-loki-update";
import { useGoals } from "./use-goals";
import { useLearn } from "./use-learn";
import { useShellAttention } from "./use-shell-attention";
import { preferencesProps } from "./views";

function markModelsChanged(): void {
  localStorage.setItem(MODELS_CHANGED_KEY, String(Date.now()));
}

function closeThisWindow(): void {
  void currentWindow()
    .close()
    .catch((e: unknown) => console.warn("loki: close settings", e));
}

export function SettingsWindow() {
  const desk = useWorkspace();
  const catchUp = useShellAttention(desk);
  const daemon = useDaemonStatus();
  const goals = useGoals(desk, "settings", (m) => void notify(m));
  const recall = useLearn(desk, "settings", (m) => void notify(m));
  const update = useLokiUpdate();
  const shortcut = useGlobalShortcut();
  const [opening, setOpening] = useState<{ page: string | null; n: number }>(() => ({ page: settingsWindow?.page ?? null, n: 0 }));

  useEffect(() => {
    if (!inDesktop) return;
    let off: (() => void) | null = null;
    let live = true;
    void listen("loki:settings-page", (ev) => setOpening((o) => ({ page: ev.payload, n: o.n + 1 })))
      .then((unlisten) => {
        if (live) off = unlisten;
        else unlisten();
      })
      .catch((e: unknown) => console.warn("loki: settings page", e));
    return () => {
      live = false;
      off?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const closeKey =
        (e.key === "w" && e.metaKey && !e.shiftKey && !e.altKey) || (e.key === "Escape" && !document.querySelector('[role="dialog"], [aria-modal="true"]'));
      if (!closeKey) return;
      e.preventDefault();
      closeThisWindow();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const sources = {
    desk,
    catchUp,
    daemon: daemon.status,
    onModelsChanged: markModelsChanged,
    update,
    shortcut,
    goals,
    recall,
  };
  return (
    <div className="loki-settings-window">
      <Settings key={opening.n} {...preferencesProps(sources)} windowed initialPage={opening.page} />
      <Notices />
    </div>
  );
}
