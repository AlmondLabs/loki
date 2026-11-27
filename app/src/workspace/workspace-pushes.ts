import type { Scope } from "../../../core/chat-scope.ts";
import type { FocusEntry } from "../../../core/attention/focus.ts";
import { parseLanes, type Lane } from "../../../core/attention/lanes.ts";
import { isReturnTimes, type Rest, type ReturnTimes } from "../../../core/attention/rest.ts";
import type { ChatStatus, ChatSummary } from "../../../core/frame-types.ts";
import type { PushFrame, Pushes } from "../../../core/frames.ts";
import { isReasoningEffort, type ReasoningEffort } from "../../../core/models.ts";
import { keepSame } from "../../../core/same-data.ts";
import { lanStatusFromFrame, type PairCode, type PairedDevice, type PhoneLanStatus } from "../shared/lan-model";

export interface DeskSocketState {
  deskList: ChatSummary[];
  desksLoaded: boolean;
  titles: Partial<Record<Scope, string>>;
  statuses: Partial<Record<Scope, ChatStatus>>;
  agentNames: Partial<Record<Scope, string>>;
  agentIds: Partial<Record<Scope, string>>;
  models: Partial<Record<Scope, string>>;
  reasoningEfforts: Partial<Record<Scope, ReasoningEffort>>;
  modes: Partial<Record<Scope, string>>;
  seenMap: Record<string, string>;
  viewedMap: Record<string, string>;
  focusMap: Record<string, FocusEntry>;
  restMap: Record<string, Rest>;
  returnTimes: ReturnTimes | null | undefined;
  lanes: Lane[] | null;
  learnVersion: number;
  usageVersion: number;
  lanStatus: PhoneLanStatus | null;
  devices: PairedDevice[] | null;
  pairCode: PairCode | null;
  macs: Pushes["peers"] | null;
  macCode: Pushes["peer_pair_code"] | null;
  restartDue: { file: string; n: number } | null;
  servedBuild: string | null;
  recentModels: string[];
  usualModels: Pushes["models_usual"]["usual"];
}

export const EMPTY_DESK_SOCKET: DeskSocketState = {
  deskList: [],
  desksLoaded: false,
  titles: {},
  statuses: {},
  agentNames: {},
  agentIds: {},
  models: {},
  reasoningEfforts: {},
  modes: {},
  seenMap: {},
  viewedMap: {},
  focusMap: {},
  restMap: {},
  returnTimes: undefined,
  lanes: null,
  learnVersion: 0,
  usageVersion: 0,
  lanStatus: null,
  devices: null,
  pairCode: null,
  macs: null,
  macCode: null,
  restartDue: null,
  servedBuild: null,
  recentModels: [],
  usualModels: {},
};

export const STATE_PUSHES: ReadonlySet<PushFrame["type"]> = new Set<PushFrame["type"]>([
  "chats",
  "learn_changed",
  "usage_changed",
  "lan_status",
  "pair_code",
  "devices",
  "peers",
  "restart_due",
  "peer_pair_code",
  "app_build",
  "models_recent",
  "models_usual",
  "seen",
  "seen_chat",
  "chat_meta",
]);

export interface PushContext {
  now: number;
  lastInteraction: number;
  phoneDemo?: boolean;
}

export const NO_YANK_MS = 2000;

export function applyPush(state: DeskSocketState, msg: PushFrame, ctx: PushContext): DeskSocketState {
  switch (msg.type) {
    case "chats":
      return withParts(state, { deskList: keepSame(state.deskList, msg.chats), desksLoaded: true });
    case "learn_changed":
      return withParts(state, { learnVersion: state.learnVersion + 1 });
    case "usage_changed":
      return withParts(state, { usageVersion: state.usageVersion + 1 });
    case "lan_status": {
      const read = lanStatusFromFrame({ ...msg });
      const lanStatus = ctx.phoneDemo ? phoneDemo({ ...read, via: "tailscale" }) : read;
      return withParts(state, { lanStatus, pairCode: lanStatus.enabled ? state.pairCode : null });
    }
    case "pair_code":
      if (typeof msg.code !== "string" || typeof msg.url !== "string" || typeof msg.expires_at !== "string") return state;
      return withParts(state, { pairCode: { code: msg.code, url: msg.url, expiresAt: msg.expires_at } });
    case "devices":
      return withParts(state, { devices: Array.isArray(msg.devices) ? msg.devices : [] });
    case "peers":
      return withParts(state, { macs: macsFromFrame(msg) });
    case "restart_due":
      return withParts(state, { restartDue: typeof msg.file === "string" ? { file: msg.file, n: (state.restartDue?.n ?? 0) + 1 } : null });
    case "peer_pair_code":
      return withParts(state, { macCode: { code: msg.code, host: msg.host, expires_at: msg.expires_at } });
    case "app_build":
      return typeof msg.build === "string" ? withParts(state, { servedBuild: msg.build }) : state;
    case "models_recent": {
      if (!Array.isArray(msg.recent)) return state;
      const next = msg.recent.filter((h): h is string => typeof h === "string");
      const cur = state.recentModels;
      return cur.length === next.length && cur.every((h, i) => h === next[i]) ? state : withParts(state, { recentModels: next });
    }
    case "models_usual": {
      const next: DeskSocketState["usualModels"] = {};
      for (const [agent, list] of Object.entries(msg.usual)) {
        if (!Array.isArray(list)) continue;
        next[agent] = list.flatMap((u: unknown) => {
          if (typeof u !== "object" || u === null || !("handle" in u) || typeof u.handle !== "string") return [];
          const effort = "reasoning_effort" in u && isReasoningEffort(u.reasoning_effort) ? u.reasoning_effort : null;
          const uses = "uses" in u && typeof u.uses === "number" ? u.uses : 1;
          return [{ handle: u.handle, reasoning_effort: effort, uses }];
        });
      }
      return withParts(state, { usualModels: keepSame(state.usualModels, next) });
    }
    case "seen": {
      const { seen, viewed, focus, rests, return_times: times, lanes } = msg;
      return withParts(state, {
        seenMap: keepSame(state.seenMap, seen),
        viewedMap: viewed && typeof viewed === "object" ? keepSame(state.viewedMap, viewed) : state.viewedMap,
        focusMap: focus && typeof focus === "object" ? keepSame(state.focusMap, focus) : state.focusMap,
        restMap: rests && typeof rests === "object" ? keepSame(state.restMap, rests) : state.restMap,
        returnTimes: times === undefined ? state.returnTimes : isReturnTimes(times) ? keepSame(state.returnTimes ?? null, times) : null,
        lanes: lanes === undefined ? state.lanes : keepSame(state.lanes ?? [], parseLanes(lanes)),
      });
    }
    case "seen_chat": {
      const { key, seen, viewed, focus, rest } = msg;
      return withParts(state, {
        seenMap: withMark(state.seenMap, key, seen),
        viewedMap: withMark(state.viewedMap, key, viewed),
        focusMap: withMark(state.focusMap, key, focus),
        restMap: withMark(state.restMap, key, rest),
      });
    }
    case "chat_meta":
      return withParts(state, {
        ...chatHeader(state, msg.scope, msg),
        agentIds: typeof msg.agent_id === "string" && msg.agent_id ? withScope(state.agentIds, msg.scope, msg.agent_id) : state.agentIds,
      });
    default:
      return state;
  }
}

export function opened(state: DeskSocketState): DeskSocketState {
  return withParts(state, { restartDue: null });
}

function chatHeader(state: DeskSocketState, s: Scope, msg: Pushes["chat_meta"]): Partial<DeskSocketState> {
  const { title, status, agent_name: agentName, model, mode } = msg;
  return {
    titles: typeof title === "string" && title ? withScope(state.titles, s, title) : state.titles,
    statuses: typeof status === "string" ? withScope(state.statuses, s, status) : state.statuses,
    agentNames: typeof agentName === "string" && agentName ? withScope(state.agentNames, s, agentName) : state.agentNames,
    models: typeof model === "string" && model ? withScope(state.models, s, model) : state.models,
    reasoningEfforts: withReasoningEffort(state.reasoningEfforts, s, msg.reasoning_effort),
    modes: typeof mode === "string" && mode ? withScope(state.modes, s, mode) : state.modes,
  };
}

export function withParts(state: DeskSocketState, parts: Partial<DeskSocketState>): DeskSocketState {
  const keys = Object.keys(parts) as Array<keyof DeskSocketState>;
  return keys.every((k) => state[k] === parts[k]) ? state : { ...state, ...parts };
}

export function withScope<T>(current: Partial<Record<Scope, T>>, scope: Scope, value: T): Partial<Record<Scope, T>> {
  return current[scope] === value ? current : { ...current, [scope]: value };
}

export function withMark<T>(current: Record<string, T>, key: string, value: T | null): Record<string, T> {
  if (value === null) return key in current ? Object.fromEntries(Object.entries(current).filter(([k]) => k !== key)) : current;
  const kept = keepSame(current[key], value);
  return kept === current[key] && key in current ? current : { ...current, [key]: kept };
}

export function macsFromFrame(msg: Pushes["peers"]): Pushes["peers"] {
  return { me: msg.me, peers: Array.isArray(msg.peers) ? msg.peers : [], tailnet: Array.isArray(msg.tailnet) ? msg.tailnet : [] };
}

export function withReasoningEffort(current: Partial<Record<Scope, ReasoningEffort>>, scope: Scope, value: unknown): Partial<Record<Scope, ReasoningEffort>> {
  if (isReasoningEffort(value)) return current[scope] === value ? current : { ...current, [scope]: value };
  if (!(scope in current)) return current;
  const { [scope]: _cleared, ...next } = current;
  return next;
}

export const PHONE_DEMO = import.meta.env.DEV && typeof location !== "undefined" && new URLSearchParams(location.search).get("phoneDemo") === "tailscale";

export function phoneDemo(s: PhoneLanStatus, serve?: boolean): PhoneLanStatus {
  const name = "my-macbook-pro.tail1234.ts.net";
  const on = serve ?? !!s.tailscale?.serve_url;
  return { ...s, tailscale: { installed: true, running: true, ip: "100.101.102.103", name, serve_url: on ? `https://${name}` : null, error: null } };
}
