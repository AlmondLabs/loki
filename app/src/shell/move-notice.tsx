import { useEffect, useEffectEvent } from "react";
import { notify } from "../components";
import { platform, type Platform } from "../desk/env";
import type { Channel } from "../../../core/version.ts";
import type { Notifier } from "./update-notice";
import type { LokiUpdate, UpdateStatus } from "./use-loki-update";

const MOVE_ID = "loki-moved";
const SITE = "https://almondlabs.github.io/loki";

export function installCommand(os: Platform, channel: Channel): string {
  if (os === "windows") {
    const line = `irm ${SITE}/install.ps1 | iex`;
    return channel === "nightly" ? `$env:LOKI_CHANNEL = "nightly"; ${line}` : line;
  }
  const line = `curl -fsSL ${SITE}/install.sh | sh`;
  return channel === "nightly" ? `${line} -s -- --nightly` : line;
}

export function moveNoticeWords(os: Platform): { title: string; description: string } {
  const mac =
    os === "macos" ? " If you installed loki with Homebrew, run brew reinstall --cask loki instead. Your Mac may ask once to let loki use its keychain." : "";
  return {
    title: "A new loki is ready to install",
    description: `This version can't update to it. Install it once with the install command, and your agents and chats stay as they are.${mac}`,
  };
}

export function showMoveNotice(status: UpdateStatus | null, os: Platform, shown: Set<string>, toast: Notifier = notify): void {
  if (!status?.moved || shown.has(status.channel)) return;
  shown.add(status.channel);
  const command = installCommand(os, status.channel);
  toast(moveNoticeWords(os).title, {
    id: MOVE_ID,
    description: moveNoticeWords(os).description,
    duration: Infinity,
    action: {
      label: "Copy Install Command",
      onClick: (e) => {
        e.preventDefault();
        void navigator.clipboard.writeText(command).catch((err: unknown) => console.warn("loki: copy install command", err));
      },
    },
    cancel: { label: "Later", onClick: () => undefined },
  });
}

const shownThisLaunch = new Set<string>();

export function MoveNotice({ update }: { update: LokiUpdate }) {
  const show = useEffectEvent(() => showMoveNotice(update.status, platform, shownThisLaunch));
  const moved = update.status?.moved ?? false;
  useEffect(() => show(), [moved]);
  return null;
}
