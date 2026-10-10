import { SHARED_SCOPE, type Scope } from "../../core/desk-core.ts";
import type { PushFrame } from "../../core/frames.ts";
import { agentsFrames, type AgentsDeps } from "./agents.ts";
import { boardFrames, type BoardDeps } from "./board.ts";
import { captureFrames } from "./capture.ts";
import { chatFrames, type ChatDeps } from "./chat.ts";
import type { FrameHandlers } from "./context.ts";
import { deskFrame, desksFrames, type DesksDeps } from "./desks.ts";
import { foldersFrames, type FoldersDeps } from "./folders.ts";
import { historyFrames, type HistoryDeps } from "./history.ts";
import { lanFrames, type LanDeps } from "./lan.ts";
import { recallFrames, type RecallDeps } from "./recall.ts";
import { seenFrames, type SeenDeps } from "./seen.ts";

/** What every frame handler needs, together: each module takes only its own part. */
export type ModuleDeps = DesksDeps & SeenDeps & HistoryDeps & FoldersDeps & RecallDeps & BoardDeps & AgentsDeps & LanDeps & ChatDeps;

/** Every feature's frame handlers (GLOSSARY.md: Frame handler), one module per feature. */
export function frameModules(deps: ModuleDeps): FrameHandlers[] {
  return [desksFrames(deps), seenFrames(deps), captureFrames(), historyFrames(deps), foldersFrames(deps), recallFrames(deps), boardFrames(deps), agentsFrames(deps), lanFrames(deps), chatFrames(deps)];
}

/** What a socket is told when it opens: its desk and the shared desk, and the recent models. */
export function welcomeFrames(deps: ModuleDeps): (scope: Scope) => PushFrame[] {
  return (scope) => [
    deskFrame(deps, scope),
    ...(scope !== SHARED_SCOPE ? [deskFrame(deps, SHARED_SCOPE)] : []),
    ...(deps.recentModels ? [{ type: "models_recent" as const, recent: deps.recentModels.read() }] : []),
  ];
}
