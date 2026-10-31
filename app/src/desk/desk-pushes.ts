import type { DeskState, Scope, WidgetManifestEntry } from "../../../core/desk-core.ts";
import type { FocusEntry } from "../../../core/attention/focus.ts";
import type { Rest } from "../../../core/attention/rest.ts";
import type { DeskStatus, DeskSummary } from "../../../core/frame-types.ts";
import type { PushFrame, Pushes } from "../../../core/frames.ts";
import { isReasoningEffort, type ReasoningEffort } from "../../../core/models.ts";
import { keepSame } from "../../../core/same-data.ts";
import { lanStatusFromFrame, type PairCode, type PairedDevice, type PhoneLanStatus } from "../phone/model";
import type { CameraTarget } from "./use-desk";
import { parseWidgetEntry, withEntry, type WidgetLogs } from "./widget-rows";

/**
 * What the mod's pushes leave in a tab (plan 058): every desk's geometry and widgets, the chat list and each chat's
 * title, status, agent, model and mode, the seen, viewed, focus and rest marks, the phone listener and paired Macs,
 * and the counters a page refetches on. `applyPush` folds one push into it, purely: the socket hook (use-desk-socket.ts)
 * keeps the socket and the effects a push asks for (a reply to its waiter, a chat's events to their listeners, a
 * gesture held until the desk came), and hands this module the rest.
 *
 * Each part keeps its object when a push changes nothing in it, and the whole state does when nothing changed at all,
 * so a repeated push redraws nothing.
 */

/** Everything the pushes leave in a tab. */
export interface DeskSocketState {
  desks: Partial<Record<Scope, DeskState>>;
  widgets: Partial<Record<Scope, WidgetManifestEntry[]>>;
  cameraTarget: CameraTarget | null;
  deskList: DeskSummary[];
  /** A desks frame has arrived: an empty list is then "no desks", not "not asked yet" (the phone's Home says which). */
  desksLoaded: boolean;
  titles: Partial<Record<Scope, string>>;
  statuses: Partial<Record<Scope, DeskStatus>>;
  agentNames: Partial<Record<Scope, string>>;
  agentIds: Partial<Record<Scope, string>>;
  models: Partial<Record<Scope, string>>;
  reasoningEfforts: Partial<Record<Scope, ReasoningEffort>>;
  modes: Partial<Record<Scope, string>>;
  seenMap: Record<string, string>;
  /** When each conversation was last looked at: apart from seen, which is "done". */
  viewedMap: Record<string, string>;
  focusMap: Record<string, FocusEntry>;
  restMap: Record<string, Rest>;
  /** Bumped when the mod says the cards changed: the Learn view refetches. */
  recallVersion: number;
  /** Bumped when the mod says the usage ledger counted more: an open usage page refetches. */
  usageVersion: number;
  /** The LAN listener (Preferences › Phone): its status, the paired phones, and the last pairing code minted here. */
  lanStatus: PhoneLanStatus | null;
  devices: PairedDevice[] | null;
  pairCode: PairCode | null;
  /** Preferences › Macs (plan 023): this Mac and the Macs paired with it, and the last Mac pairing code minted here. */
  macs: Pushes["peers"] | null;
  macCode: Pushes["peer_pair_code"] | null;
  /**
   * A daemon restart due after a checkout's code changed (plan 024): the file, and which push said so, so that each
   * change shows the notice again even when it names the same file. A restarted daemon owes none.
   */
  restartDue: { file: string; n: number } | null;
  /** The canvas build the mod is serving now (`app_build`); the phone reloads on it. */
  servedBuild: string | null;
  /** The models used lately, latest first (mod/models.ts). */
  recentModels: string[];
  /** Each desk's widget change log (desk/widget-rows.ts): from history replies and live `widget_change` frames. */
  widgetLogs: WidgetLogs;
}

/** A tab before its first push. */
export const EMPTY_DESK_SOCKET: DeskSocketState = {
  desks: {},
  widgets: {},
  cameraTarget: null,
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
  recallVersion: 0,
  usageVersion: 0,
  lanStatus: null,
  devices: null,
  pairCode: null,
  macs: null,
  macCode: null,
  restartDue: null,
  servedBuild: null,
  recentModels: [],
  widgetLogs: {},
};

/**
 * The pushes `applyPush` folds in. The socket hook calls it for these only: a push that leaves the state alone (a
 * chat's streamed events above all) then costs no update and no redraw at all.
 */
export const STATE_PUSHES: ReadonlySet<PushFrame["type"]> = new Set<PushFrame["type"]>([
  "desk",
  "state",
  "widgets",
  "camera",
  "desks",
  "recall_changed",
  "usage_changed",
  "lan_status",
  "pair_code",
  "devices",
  "peers",
  "restart_due",
  "peer_pair_code",
  "app_build",
  "models_recent",
  "widget_change",
  "seen",
  "seen_chat",
  "desk_title",
]);

/** What a push is read against: the clock, and when the person last touched the canvas (a camera move waits for them). */
export interface PushContext {
  now: number;
  lastInteraction: number;
  /** Dev only: Preferences › Phone reads as if Tailscale were running (PHONE_DEMO). */
  phoneDemo?: boolean;
}

/** After the person touches the canvas, the agent's camera moves wait this long. */
export const NO_YANK_MS = 2000;

/** The state with one push folded in; the same object when the push changes nothing. */
export function applyPush(state: DeskSocketState, msg: PushFrame, ctx: PushContext): DeskSocketState {
  switch (msg.type) {
    case "desk": {
      const s = msg.scope;
      return withParts(state, {
        ...chatHeader(state, s, msg),
        agentIds: typeof msg.agent_id === "string" && msg.agent_id ? withScope(state.agentIds, s, msg.agent_id) : state.agentIds,
        desks: { ...state.desks, [s]: msg.state },
        widgets: { ...state.widgets, [s]: msg.widgets },
      });
    }
    case "state":
      return withParts(state, { desks: { ...state.desks, [msg.scope]: msg.state } });
    case "widgets":
      return withParts(state, { widgets: { ...state.widgets, [msg.scope]: msg.widgets } });
    case "camera": {
      if (typeof msg.widget_id !== "string" || ctx.now - ctx.lastInteraction <= NO_YANK_MS) return state;
      const widgetIds = Array.isArray(msg.widget_ids) && msg.widget_ids.length ? msg.widget_ids : [msg.widget_id];
      return withParts(state, { cameraTarget: { widgetId: msg.widget_id, widgetIds, nonce: (state.cameraTarget?.nonce ?? 0) + 1 } });
    }
    case "desks":
      return withParts(state, { deskList: keepSame(state.deskList, msg.desks), desksLoaded: true });
    case "recall_changed":
      return withParts(state, { recallVersion: state.recallVersion + 1 });
    case "usage_changed":
      return withParts(state, { usageVersion: state.usageVersion + 1 });
    case "lan_status": {
      const read = lanStatusFromFrame({ ...msg });
      const lanStatus = ctx.phoneDemo ? phoneDemo({ ...read, via: "tailscale" }) : read;
      // A code is only redeemable while the listener is up.
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
    case "widget_change": {
      // Kept under its own desk, so another desk's thread has it when that desk next opens; the phone ignores it.
      const entry = parseWidgetEntry(msg.entry);
      return entry ? withParts(state, { widgetLogs: withEntry(state.widgetLogs, entry) }) : state;
    }
    case "seen": {
      // Every chat's marks, on connect and after marks from a paired Mac: a map it repeats keeps its object. A mod from
      // before viewed, focus or rests sends none of that map: what is here stays rather than every mark forgotten.
      const { seen, viewed, focus, rests } = msg;
      return withParts(state, {
        seenMap: keepSame(state.seenMap, seen),
        viewedMap: viewed && typeof viewed === "object" ? keepSame(state.viewedMap, viewed) : state.viewedMap,
        focusMap: focus && typeof focus === "object" ? keepSame(state.focusMap, focus) : state.focusMap,
        restMap: rests && typeof rests === "object" ? keepSame(state.restMap, rests) : state.restMap,
      });
    }
    case "seen_chat": {
      // One chat's marks after a change to it alone (plan 055): that key set or cleared, every other map kept.
      const { key, seen, viewed, focus, rest } = msg;
      return withParts(state, {
        seenMap: withMark(state.seenMap, key, seen),
        viewedMap: withMark(state.viewedMap, key, viewed),
        focusMap: withMark(state.focusMap, key, focus),
        restMap: withMark(state.restMap, key, rest),
      });
    }
    case "desk_title":
      // Sent again on every title refresh: a repeat keeps each map as it is.
      return withParts(state, chatHeader(state, msg.scope, msg));
    default:
      return state;
  }
}

/** A socket that opened: a daemon just started owes no restart, and one still owing says so in its welcome. */
export function opened(state: DeskSocketState): DeskSocketState {
  return withParts(state, { restartDue: null });
}

/** The header parts of a chat a `desk` or `desk_title` push carries; each map the same when its value is. */
function chatHeader(state: DeskSocketState, s: Scope, msg: Pushes["desk_title"]): Partial<DeskSocketState> {
  // Pushes arrive from the mod unchecked: each part is taken only when it is what it says.
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

/** The state with `parts` in it; the same object when every part already is. */
export function withParts(state: DeskSocketState, parts: Partial<DeskSocketState>): DeskSocketState {
  const keys = Object.keys(parts) as Array<keyof DeskSocketState>;
  return keys.every((k) => state[k] === parts[k]) ? state : { ...state, ...parts };
}

/** The map with one scope set; the same object when it already holds that value. */
export function withScope<T>(current: Partial<Record<Scope, T>>, scope: Scope, value: T): Partial<Record<Scope, T>> {
  return current[scope] === value ? current : { ...current, [scope]: value };
}

/**
 * A marks map with one chat's value set, or removed when it has none; the same map when that changes nothing, so a
 * repeat redraws nothing.
 */
export function withMark<T>(current: Record<string, T>, key: string, value: T | null): Record<string, T> {
  if (value === null) return key in current ? Object.fromEntries(Object.entries(current).filter(([k]) => k !== key)) : current;
  const kept = keepSame(current[key], value);
  return kept === current[key] && key in current ? current : { ...current, [key]: kept };
}

/** Preferences › Macs from a `peers` push: this Mac, the Macs paired with it, and the computers on its tailnet (plan 023). */
export function macsFromFrame(msg: Pushes["peers"]): Pushes["peers"] {
  return { me: msg.me, peers: Array.isArray(msg.peers) ? msg.peers : [], tailnet: Array.isArray(msg.tailnet) ? msg.tailnet : [] };
}

/** The efforts map with one scope set, or cleared when the value is not a level. */
export function withReasoningEffort(current: Partial<Record<Scope, ReasoningEffort>>, scope: Scope, value: unknown): Partial<Record<Scope, ReasoningEffort>> {
  if (isReasoningEffort(value)) return current[scope] === value ? current : { ...current, [scope]: value };
  if (!(scope in current)) return current;
  const { [scope]: _cleared, ...next } = current;
  return next;
}

/**
 * Dev only: `?phoneDemo=tailscale` on the Vite tab makes Preferences › Phone read as if Tailscale were
 * running on this Mac, so the route chooser and the https switch can be seen without a tailnet. The
 * flag is compiled out of production builds; `setVia` / `setServe` then change local state instead of
 * asking the mod. Remove once the mod's `tailscale.ts` is in and a real tailnet is at hand.
 */
export const PHONE_DEMO = import.meta.env.DEV && typeof location !== "undefined" && new URLSearchParams(location.search).get("phoneDemo") === "tailscale";

/**
 * The LAN status as it would read with Tailscale running on this Mac (fixed made-up names and address), for the
 * dev-only `PHONE_DEMO`; `serve` overrides whether Tailscale serve is on.
 */
export function phoneDemo(s: PhoneLanStatus, serve?: boolean): PhoneLanStatus {
  const name = "my-macbook-pro.tail1234.ts.net";
  const on = serve ?? !!s.tailscale?.serve_url;
  return { ...s, tailscale: { installed: true, running: true, ip: "100.101.102.103", name, serve_url: on ? `https://${name}` : null, error: null } };
}
