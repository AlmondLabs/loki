/** A desk scope: "shared" or a sanitized conversation id. */
export type Scope = string;
export const SHARED_SCOPE: Scope = "shared";
export const MAIN_CHAT_ID = "default";
const MAIN_SCOPE_PREFIX = `${MAIN_CHAT_ID}-`;

export const isMainChat = (conversationId: string | null | undefined): boolean => conversationId === MAIN_CHAT_ID;

export const mainChatAgent = (scope: string): string | null => (scope.startsWith(MAIN_SCOPE_PREFIX) ? scope.slice(MAIN_SCOPE_PREFIX.length) : null);

export function scopeFor(conversationId: string | null | undefined, agentId?: string | null): Scope {
  if (!conversationId) return SHARED_SCOPE;
  const raw = isMainChat(conversationId) && agentId ? `${MAIN_SCOPE_PREFIX}${agentId}` : conversationId;
  const s = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
  return s || SHARED_SCOPE;
}

export function backendName(key: string): string {
  const bytes = new TextEncoder().encode(key);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa === "function" ? btoa(bin) : Buffer.from(bytes).toString("base64");
  return b64.replace(/=+$/, "");
}

export function conversationDirName(conversationId: string, agentId?: string | null): string {
  return backendName(isMainChat(conversationId) && agentId ? `${MAIN_CHAT_ID}:${agentId}` : `conversation:${conversationId}`);
}
