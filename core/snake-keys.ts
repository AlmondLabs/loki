/**
 * loki's own data is snake_case (docs/style.md §2): its bridge frames, the files it writes and the metadata it keeps.
 * Until October 2026 some of it was camelCase; what was saved then is read through `migrateKeys`, which renames those
 * old field names, and the reader writes the file back once. Only the names below are renamed, never every camelCase
 * key: a map keyed by ids (widgets, chats, files) may hold capitals that are data.
 */

/** Each field saved camelCase before October 2026, and its name now. */
export const OLD_KEYS: Readonly<Partial<Record<string, string>>> = {
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
  turnId: "turn_id",
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

/**
 * A task's metadata keys in beads as loki wrote them before October 2026, and their names now (`by`, `agent`, `desk`,
 * `folder`, `origin` and `quote` were already one word). mod/tasks.ts reads tasks through it and rewrites each one once.
 */
export const OLD_TASK_METADATA_KEYS: Readonly<Partial<Record<string, string>>> = {
  agentId: "agent_id",
  assignedAgent: "assigned_agent",
  assignedAgentId: "assigned_agent_id",
  assignedAt: "assigned_at",
  assignedDesk: "assigned_desk",
  assignedTo: "assigned_to",
  doneAsked: "done_asked",
  doneAskedAt: "done_asked_at",
  doneAskedBy: "done_asked_by",
  lastNote: "last_note",
  lastNoteAt: "last_note_at",
  msgAt: "msg_at",
  msgKey: "msg_key",
  msgRole: "msg_role",
};

/**
 * `value` with every old field name in OLD_KEYS renamed, at any depth, and whether anything changed. Keys outside the
 * list are kept as they are; when an object holds both spellings, the snake_case one wins.
 */
export function migrateKeys<T>(value: T, keys: Readonly<Partial<Record<string, string>>> = OLD_KEYS): { value: T; changed: boolean } {
  let changed = false;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, inner] of Object.entries(v)) {
      const renamed = keys[k];
      if (renamed && renamed !== k) {
        changed = true;
        if (!(renamed in v)) out[renamed] = walk(inner);
      } else out[k] = walk(inner);
    }
    return out;
  };
  const next = walk(value) as T;
  return { value: next, changed };
}
