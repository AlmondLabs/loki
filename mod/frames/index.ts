import { SHARED_SCOPE, type Scope } from "../../core/desk-core.ts";
import type { PushFrame } from "../../core/frames.ts";
import { agentsFrames, type AgentsDeps } from "./agents.ts";
import { captureFrames } from "./capture.ts";
import { chatFrames, type ChatDeps } from "./chat.ts";
import { daemonFrames, type DaemonDeps } from "./daemon.ts";
import type { FrameHandlers } from "./context.ts";
import { deskFrame, desksFrames, type DesksDeps } from "./desks.ts";
import { foldersFrames, type FoldersDeps } from "./folders.ts";
import { historyFrames, type HistoryDeps } from "./history.ts";
import { lanFrames, type LanDeps } from "./lan.ts";
import { peersFrames, type PeersDeps } from "./peers.ts";
import { recallFrames, type RecallDeps } from "./recall.ts";
import { seenFrames, type SeenDeps } from "./seen.ts";
import { suggestionFrames, type SuggestionDeps } from "./suggestions.ts";
import { usageFrames, type UsageDeps } from "./usage.ts";

/** What every frame handler needs, together: each module takes only its own part. */
export type ModuleDeps = DesksDeps &
  SeenDeps &
  HistoryDeps &
  FoldersDeps &
  RecallDeps &
  AgentsDeps &
  LanDeps &
  PeersDeps &
  ChatDeps &
  SuggestionDeps &
  UsageDeps &
  DaemonDeps;

/** Every feature's frame handlers (glossary.md: Frame handler), one module per feature. */
export function frameModules(deps: ModuleDeps): FrameHandlers[] {
  return [
    desksFrames(deps),
    seenFrames(deps),
    captureFrames(),
    historyFrames(deps),
    foldersFrames(deps),
    recallFrames(deps),
    agentsFrames(deps),
    lanFrames(deps),
    peersFrames(deps),
    chatFrames(deps),
    suggestionFrames(deps),
    usageFrames(deps),
    daemonFrames(deps),
  ];
}

/** What a socket is told when it opens: its desk and the shared desk, and the recent models. */
export function welcomeFrames(deps: ModuleDeps): (scope: Scope) => PushFrame[] {
  return (scope) => [
    deskFrame(deps, scope),
    ...(scope !== SHARED_SCOPE ? [deskFrame(deps, SHARED_SCOPE)] : []),
    ...(deps.recentModels ? [{ type: "models_recent" as const, recent: deps.recentModels.read() }] : []),
    // The Macs paired with this one, for where an agent lives and, later, where each chat runs (plan 023).
    ...(deps.peers ? [{ type: "peers" as const, ...deps.peers.view() }] : []),
    // A restart due after a checkout's daemon code changed (plan 024): the window offers it.
    ...(deps.daemon?.restartDue() ? [{ type: "restart_due" as const, file: deps.daemon.restartDue() }] : []),
  ];
}
