export type CanvasTab = "messages" | "advisor" | "canvas";
export type PaneView = "messages" | "advisor" | "inset";

export interface PaneState {
  readonly tabs: Readonly<Record<string, CanvasTab>>;
}
export const EMPTY_PANE: PaneState = { tabs: {} };

export const tabOf = (s: PaneState, scope: string): CanvasTab => s.tabs[scope] ?? "messages";

export function chooseTab(s: PaneState, scope: string, tab: CanvasTab): PaneState {
  if (tabOf(s, scope) === tab) return s;
  return { tabs: { ...s.tabs, [scope]: tab } };
}

export const openTab = (s: PaneState, scope: string): PaneState => chooseTab(s, scope, "messages");

export const shownTab = (tab: CanvasTab, hasAdvisor: boolean): CanvasTab => (tab === "advisor" && !hasAdvisor ? "messages" : tab);

export function escapeTab(s: PaneState, scope: string, shown: CanvasTab, { typing }: { typing: boolean }): PaneState | null {
  if (typing || shown === "messages") return null;
  return chooseTab(s, scope, "messages");
}

const VIEW: Record<CanvasTab, PaneView> = { messages: "messages", advisor: "advisor", canvas: "inset" };

export const paneView = (active: boolean, tab: CanvasTab): PaneView | null => (active ? VIEW[tab] : null);

const ADVISOR_KEYS = new Set(["chat.focus", "chat.find", "chat.model"]);
const MESSAGES_KEYS = new Set([...ADVISOR_KEYS, "chat.mode", "chat.suggestions"]);

export function chatKeyTarget(id: string, tab: CanvasTab): PaneView | null {
  if (tab === "canvas") return "inset";
  if (tab === "advisor") return ADVISOR_KEYS.has(id) ? "advisor" : null;
  return MESSAGES_KEYS.has(id) ? "messages" : null;
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
