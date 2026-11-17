import { useEffect, useState } from "react";
import { Notices, notify } from "../components";
import { inTauri, settingsWindow } from "../desk/env";
import { useDesk } from "../desk/use-desk";
import { Settings } from "../settings/settings";
import { useDaemonStatus } from "./bootstrap";
import { MODELS_CHANGED_KEY } from "./open-settings";
import { useChatLayout } from "./use-chat-layout";
import { useGlobalShortcut } from "./use-global-shortcut";
import { useLokiUpdate } from "./use-loki-update";
import { useRecall } from "./use-recall";
import { useShellAttention } from "./use-shell-attention";
import { preferencesProps } from "./views";

function markModelsChanged(): void {
  localStorage.setItem(MODELS_CHANGED_KEY, String(Date.now()));
}

function closeThisWindow(): void {
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().close())
    .catch((e: unknown) => console.warn("loki: close settings", e));
}

export function SettingsWindow() {
  const desk = useDesk();
  const catchUp = useShellAttention(desk, desk.attention.capture);
  const daemon = useDaemonStatus();
  const recall = useRecall(desk, "settings", (m) => void notify(m));
  const update = useLokiUpdate();
  const shortcut = useGlobalShortcut();
  const chat = useChatLayout(desk);
  const [opening, setOpening] = useState<{ page: string | null; n: number }>(() => ({ page: settingsWindow?.page ?? null, n: 0 }));

  useEffect(() => {
    if (!inTauri) return;
    let off: (() => void) | null = null;
    let live = true;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const unlisten = await listen<string>("loki:settings-page", (ev) => setOpening((o) => ({ page: ev.payload, n: o.n + 1 })));
      if (live) off = unlisten;
      else unlisten();
    });
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
    chatWidth: chat.chatWidth,
    onChatWidth: chat.setChatWidth,
    chatPlacement: chat.chatPlacement,
    onChatPlacement: chat.setChatPlacement,
    onModelsChanged: markModelsChanged,
    update,
    shortcut,
    recall,
  };
  return (
    <div className="loki-settings-window">
      <Settings key={opening.n} {...preferencesProps(sources)} windowed initialPage={opening.page} />
      <Notices />
    </div>
  );
}
