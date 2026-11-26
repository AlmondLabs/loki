import { SHARED_SCOPE, type Scope } from "../../core/canvas-core.ts";
import type { PushFrame } from "../../core/frames.ts";
import { accountFrames, type AccountsDeps } from "./accounts.ts";
import { agentsFrames, type AgentsDeps } from "./agents.ts";
import { chatFrames, type ChatDeps } from "./chat.ts";
import { daemonFrames, type DaemonDeps } from "./daemon.ts";
import type { FrameHandlers } from "./context.ts";
import { canvasFrame, canvasFrames, type CanvasDeps } from "./canvas.ts";
import { foldersFrames, type FoldersDeps } from "./folders.ts";
import { historyFrames, type HistoryDeps } from "./history.ts";
import { lanFrames, type LanDeps } from "./lan.ts";
import { linkFrames, type LinkDeps } from "./links.ts";
import { peersFrames, type PeersDeps } from "./peers.ts";
import { learnFrames, type LearnDeps } from "./learn.ts";
import { replyFrames, type ReplyDeps } from "./replies.ts";
import { seenFrame, seenFrames, type SeenDeps } from "./seen.ts";
import { suggestionFrames, type SuggestionDeps } from "./suggestions.ts";
import { usageFrames, type UsageDeps } from "./usage.ts";

export type ModuleDeps = CanvasDeps &
  SeenDeps &
  HistoryDeps &
  FoldersDeps &
  LearnDeps &
  AgentsDeps &
  LanDeps &
  PeersDeps &
  ChatDeps &
  SuggestionDeps &
  ReplyDeps &
  LinkDeps &
  UsageDeps &
  AccountsDeps &
  DaemonDeps;

export function frameModules(deps: ModuleDeps): FrameHandlers[] {
  return [
    canvasFrames(deps),
    seenFrames(deps),
    historyFrames(deps),
    foldersFrames(deps),
    learnFrames(deps),
    agentsFrames(deps),
    lanFrames(deps),
    peersFrames(deps),
    chatFrames(deps),
    suggestionFrames(deps),
    replyFrames(deps),
    linkFrames(deps),
    usageFrames(deps),
    accountFrames(deps),
    daemonFrames(deps),
  ];
}

export function welcomeFrames(deps: ModuleDeps): (scope: Scope) => PushFrame[] {
  return (scope) => [
    canvasFrame(deps, scope),
    ...(scope !== SHARED_SCOPE ? [canvasFrame(deps, SHARED_SCOPE)] : []),
    ...(deps.listChats ? [{ type: "chats" as const, chats: deps.listChats() }] : []),
    ...(deps.seen ? [seenFrame(deps)] : []),
    ...(deps.recentModels ? [{ type: "models_recent" as const, recent: deps.recentModels.read() }] : []),
    ...(deps.usualModels ? [{ type: "models_usual" as const, usual: deps.usualModels.read() }] : []),
    ...(deps.peers ? [{ type: "peers" as const, ...deps.peers.view() }] : []),
    ...(deps.daemon?.restartDue() ? [{ type: "restart_due" as const, file: deps.daemon.restartDue() }] : []),
  ];
}
