export type DeskTab = "messages" | "desk";
export type PaneView = "messages" | "inset";

export interface PaneState {
  readonly tabs: Readonly<Record<string, DeskTab>>;
}
export const EMPTY_PANE: PaneState = { tabs: {} };

export const tabOf = (s: PaneState, scope: string): DeskTab => s.tabs[scope] ?? "messages";

export function chooseTab(s: PaneState, scope: string, tab: DeskTab): PaneState {
  if (tabOf(s, scope) === tab) return s;
  return { tabs: { ...s.tabs, [scope]: tab } };
}

export const openTab = (s: PaneState, scope: string): PaneState => chooseTab(s, scope, "messages");

export function escapeTab(s: PaneState, scope: string, { typing }: { typing: boolean }): PaneState | null {
  if (typing || tabOf(s, scope) !== "desk") return null;
  return chooseTab(s, scope, "messages");
}

export const paneView = (active: boolean, tab: DeskTab): PaneView | null => (!active ? null : tab === "messages" ? "messages" : "inset");

export function chatKeyTarget(id: string, tab: DeskTab): PaneView | null {
  if (tab === "desk") return "inset";
  return id === "chat.focus" || id === "chat.find" || id === "chat.model" || id === "chat.mode" || id === "chat.suggestions" ? "messages" : null;
}

export interface TickRoute {
  readonly value: number;
  readonly to: PaneView | null;
  readonly chat: string | null;
}
export const EMPTY_ROUTE: TickRoute = { value: 0, to: null, chat: null };

export function routeTick(r: TickRoute, value: number, visible: PaneView | null, chat: string | null): TickRoute {
  if (value !== r.value) return { value, to: visible, chat };
  if (r.to !== null && (r.to !== visible || r.chat !== chat)) return { value, to: null, chat };
  return r;
}
export const tickFor = (r: TickRoute, view: PaneView): number => (r.to === view ? r.value : 0);

export interface FrameRequest {
  readonly widgetId: string;
  readonly nonce: number;
}
export const nextFrame = (prev: FrameRequest | null, widgetId: string): FrameRequest => ({ widgetId, nonce: (prev?.nonce ?? 0) + 1 });

export function agentState({ status, approval, question }: { status: "idle" | "thinking" | "streaming"; approval: unknown; question: unknown }): string | null {
  return approval ? "needs approval" : question ? "asked you" : status === "streaming" ? "writing" : status === "thinking" ? "working" : null;
}
