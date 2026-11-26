import type { WidgetManifestEntry } from "../../core/canvas-core.ts";
import { createBridge, type BridgeDeps } from "../../mod/bridge.ts";
import { frameModules, welcomeFrames, type ModuleDeps } from "../../mod/frames/index.ts";
import { CanvasStore } from "../../mod/canvas-store.ts";
import type { Client } from "../../mod/server.ts";
import type { WidgetsWatcher } from "../../mod/widgets-fs.ts";

const RENAMED_FIELDS: Readonly<Partial<Record<string, string>>> = {
  agentId: "agent_id",
  agentName: "agent_name",
  alwaysLoad: "always_load",
  apiKey: "api_key",
  appServed: "app_served",
  approvalId: "approval_id",
  byAgent: "by_agent",
  byConversation: "by_conversation",
  closedAt: "closed_at",
  configPath: "config_path",
  conversationId: "conversation_id",
  createdAt: "created_at",
  dailyCap: "daily_cap",
  dataShape: "data_shape",
  defaultPath: "default_path",
  dismissedLeads: "dismissed_leads",
  expiresAt: "expires_at",
  hasProfile: "has_profile",
  isDefault: "is_default",
  isFeatured: "is_featured",
  isLink: "is_link",
  lastActive: "last_active",
  lastAsk: "last_ask",
  lastAssistantText: "last_assistant_text",
  lastCommit: "last_commit",
  lastMessageAt: "last_message_at",
  lastReview: "last_review",
  lastRole: "last_role",
  lastRunAt: "last_run_at",
  lastRunNote: "last_run_note",
  lastSeenAt: "last_seen_at",
  lastVia: "last_via",
  learnLast: "learn_last",
  learnWritten: "learn_written",
  linkPath: "link_path",
  modelSettings: "model_settings",
  modifiedAt: "modified_at",
  offFor: "off_for",
  providerId: "provider_id",
  questionId: "question_id",
  readOnly: "read_only",
  reasoningEffort: "reasoning_effort",
  requestId: "request_id",
  rowWidth: "row_width",
  sendId: "send_id",
  serveUrl: "serve_url",
  signIn: "sign_in",
  signedIn: "signed_in",
  startedAt: "started_at",
  systemHead: "system_head",
  timedOut: "timed_out",
  tokenHash: "token_hash",
  toolName: "tool_name",
  updatedAt: "updated_at",
  updatedBy: "updated_by",
  upstreamPath: "upstream_path",
  viewedAt: "viewed_at",
  seenAt: "seen_at",
  widgetId: "widget_id",
  widgetIds: "widget_ids",
  widgetLog: "widget_log",
  writtenToday: "written_today",
  pendingApproval: "pending_approval",
  pendingQuestion: "pending_question",
};

const DATA_FIELDS = new Set(["data", "overlay", "layout", "input", "args", "metadata"]);

export function assertSnakeCase(frame: unknown, path = "frame"): void {
  if (Array.isArray(frame)) return frame.forEach((v, i) => assertSnakeCase(v, `${path}[${i}]`));
  if (!frame || typeof frame !== "object") return;
  for (const [k, v] of Object.entries(frame)) {
    const now = RENAMED_FIELDS[k];
    if (now) throw new Error(`${path}.${k} is camelCase; on the wire it is ${now}`);
    if (!DATA_FIELDS.has(k)) assertSnakeCase(v, `${path}.${k}`);
  }
}

export function client(scope: string, deviceId?: string, peerId?: string): Client & { sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  return {
    scope,
    sent,
    ...(deviceId ? { deviceId } : {}),
    ...(peerId ? { peerId } : {}),
    send: (m) => {
      assertSnakeCase(m);
      sent.push(m as Record<string, unknown>);
    },
  };
}

export function fakeWidgets(entries: WidgetManifestEntry[]): WidgetsWatcher & { runtime: Map<string, string> } {
  const runtime = new Map<string, string>();
  return {
    runtime,
    entries: (scope) => entries.filter((e) => !scope || e.scope === scope).map((e) => (runtime.has(e.id) ? { ...e, error: runtime.get(e.id) } : e)),
    get: (id) => entries.find((e) => e.id === id),
    setRuntimeError(id, msg) {
      const prev = runtime.get(id) ?? null;
      if (prev === msg) return false;
      if (msg) runtime.set(id, msg);
      else runtime.delete(id);
      return true;
    },
    rescan: async () => {},
    close: () => {},
  };
}

type BridgeOf = Partial<ModuleDeps> & { broadcast?: BridgeDeps["broadcast"]; modules?: BridgeDeps["modules"] };

export function bridgeOf(deps: BridgeOf = {}) {
  const full: ModuleDeps = { store: new CanvasStore(), widgets: fakeWidgets([]), ...deps };
  return createBridge({
    modules: deps.modules ?? frameModules(full),
    welcome: welcomeFrames(full),
    broadcast: deps.broadcast ?? (() => {}),
  });
}

export function bridgeWith(deps: BridgeOf = {}) {
  const broadcasts: Array<{ frame: Record<string, unknown>; scope?: string }> = [];
  const bridge = bridgeOf({
    ...deps,
    broadcast: (frame, scope) => (assertSnakeCase(frame), broadcasts.push({ frame: frame as Record<string, unknown>, scope })),
  });
  return { bridge, broadcasts };
}

export const settled = () => new Promise((r) => setTimeout(r, 0));
