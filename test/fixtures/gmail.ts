import { createHash } from "node:crypto";

export interface FakeRequest {
  method: string;
  url: URL;
  body: string;
}

interface Code {
  challenge: string;
  client_id: string;
  redirect: string;
  scope: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export const ALL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
  "https://www.googleapis.com/auth/directory.readonly",
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
];
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export function fakeGoogle(opts: { now: () => Date; email?: string }) {
  const codes = new Map<string, Code>();
  const access = new Map<string, { expires: number; client_id: string }>();
  const refresh = new Map<string, { client_id: string; scope: string }>();
  const requests: FakeRequest[] = [];
  const drafts: Array<{ raw: string; threadId: string }> = [];
  const sentMail: Array<{ raw: string; threadId: string }> = [];
  const modified: Array<{ ids: unknown; addLabelIds?: unknown; removeLabelIds?: unknown }> = [];
  const state = {
    oldestHistoryId: 100,
    history: [] as Array<{ id: string; messagesAdded: Array<{ message: { id: string; threadId: string } }> }>,
    historyId: "500",
    sendAs: ["ada@acme.com", "ada@example.org"] as string[] | number,
    adminBlocked: false,
    email: opts.email ?? "ada@acme.com",
  };
  const issued = { access: [] as string[], refresh: [] as string[] };
  let tokenSeq = 0;

  const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const issue = (clientId: string) => {
    const token = `access-${++tokenSeq}`;
    issued.access.push(token);
    access.set(token, { expires: opts.now().getTime() + 3600 * 1000, client_id: clientId });
    return token;
  };

  const token = (form: URLSearchParams): Response => {
    if (form.get("grant_type") === "authorization_code") {
      const code = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      if (createHash("sha256").update(verifier).digest("base64url") !== code?.challenge) return json(400, { error: "invalid_grant" });
      if (code.client_id !== form.get("client_id") || code.redirect !== form.get("redirect_uri")) return json(400, { error: "invalid_client" });
      const refreshToken = `refresh-${++tokenSeq}`;
      refresh.set(refreshToken, { client_id: code.client_id, scope: code.scope });
      issued.refresh.push(refreshToken);
      return json(200, { access_token: issue(code.client_id), refresh_token: refreshToken, expires_in: 3600, token_type: "Bearer", scope: code.scope });
    }
    if (form.get("grant_type") === "refresh_token") {
      if (state.adminBlocked) return json(400, { error: "admin_policy_enforced" });
      const held = refresh.get(form.get("refresh_token") ?? "");
      const revoked = json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
      if (held === undefined) return revoked;
      if (held.client_id !== form.get("client_id")) return revoked;
      return json(200, { access_token: issue(held.client_id), expires_in: 3600, token_type: "Bearer", scope: held.scope });
    }
    return json(400, { error: "unsupported_grant_type" });
  };

  const gmail = (req: FakeRequest, bearer: string): Response => {
    const held = access.get(bearer);
    if (!held || held.expires <= opts.now().getTime()) return json(401, { error: { code: 401, message: "Invalid Credentials", status: "UNAUTHENTICATED" } });
    if (state.adminBlocked)
      return json(403, {
        error: { code: 403, message: "Access blocked by your admin", status: "PERMISSION_DENIED", details: [{ reason: "ADMIN_POLICY_ENFORCED" }] },
      });
    const path = req.url.pathname.replace("/gmail/v1/users/me", "");
    const q = req.url.searchParams;
    if (path === "/profile") return json(200, { emailAddress: state.email, historyId: state.historyId });
    if (path === "/settings/sendAs")
      return typeof state.sendAs === "number"
        ? json(state.sendAs, { error: { code: state.sendAs, message: "Insufficient Permission", errors: [{ reason: "insufficientPermissions" }] } })
        : json(200, { sendAs: state.sendAs.map((a) => ({ sendAsEmail: a })) });
    const attachment = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(path);
    if (attachment) return json(200, { data: Buffer.from(`file ${attachment[1]}/${attachment[2]}`).toString("base64url") });
    if (path === "/history") {
      if (Number(q.get("startHistoryId")) < state.oldestHistoryId) return json(404, { error: { code: 404, message: "Requested entity was not found." } });
      const from = Number(q.get("pageToken") ?? "0");
      const page = state.history.slice(from, from + 2);
      const next = from + 2 < state.history.length ? String(from + 2) : undefined;
      return json(200, { history: page, historyId: state.historyId, ...(next ? { nextPageToken: next } : {}) });
    }
    if (path === "/messages") {
      if (q.get("pageToken") === "p2") return json(200, { messages: [{ id: "m3", threadId: "t2" }] });
      return json(200, {
        messages: [
          { id: "m1", threadId: "t1" },
          { id: "m2", threadId: "t1" },
        ],
        nextPageToken: "p2",
      });
    }
    const thread = /^\/threads\/([^/]+)$/.exec(path);
    if (thread && req.method === "GET")
      return json(200, {
        id: thread[1],
        historyId: "480",
        messages: [
          {
            id: "m1",
            threadId: thread[1],
            labelIds: ["INBOX", "UNREAD"],
            snippet: "lunch on friday?",
            historyId: "480",
            internalDate: "1793000000000",
            payload: {
              mimeType: "text/plain",
              headers: [{ name: "Subject", value: "Lunch" }],
              body: { size: 16, ...(q.get("format") === "full" ? { data: "bHVuY2ggb24gZnJpZGF5Pw" } : {}) },
            },
          },
        ],
      });
    if (path === "/messages/batchModify" && req.method === "POST") {
      const { ids, addLabelIds, removeLabelIds } = JSON.parse(req.body) as { ids: unknown; addLabelIds?: unknown; removeLabelIds?: unknown };
      modified.push({ ids, ...(addLabelIds === undefined ? {} : { addLabelIds }), ...(removeLabelIds === undefined ? {} : { removeLabelIds }) });
      return new Response(null, { status: 204 });
    }
    if (path === "/labels" && req.method === "GET")
      return json(200, {
        labels: [
          { id: "INBOX", name: "INBOX", type: "system" },
          { id: "UNREAD", name: "UNREAD", type: "system" },
          { id: "Label_7", name: "Receipts", type: "user" },
        ],
      });
    if (path === "/messages/send" && req.method === "POST") {
      const message = JSON.parse(req.body) as { raw: string; threadId: string };
      sentMail.push(message);
      return json(200, { id: `s${sentMail.length}`, threadId: message.threadId });
    }
    if (path === "/drafts" && req.method === "POST") {
      const { message } = JSON.parse(req.body) as { message: { raw: string; threadId: string } };
      drafts.push(message);
      return json(200, { id: `d${drafts.length}`, message: { id: `dm${drafts.length}`, threadId: message.threadId } });
    }
    return json(404, { error: { code: 404, message: "Not Found" } });
  };

  const fetchFn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = typeof init?.body === "string" ? init.body : "";
    const req: FakeRequest = { method: init?.method ?? "GET", url, body };
    requests.push(req);
    if (url.href === TOKEN_URL && req.method === "POST") return Promise.resolve(token(new URLSearchParams(body)));
    if (url.href === USERINFO_URL) {
      const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
      return Promise.resolve(access.has(bearer) ? json(200, { sub: "1", email: state.email, email_verified: true }) : json(401, { error: "invalid_token" }));
    }
    if (url.href.startsWith(API)) {
      const headers = new Headers(init?.headers);
      return Promise.resolve(gmail(req, (headers.get("authorization") ?? "").replace(/^Bearer /, "")));
    }
    return Promise.resolve(json(404, {}));
  };

  return {
    fetch: fetchFn,
    requests,
    issued,
    drafts,
    sentMail,
    modified,
    state,
    authorize(authUrl: string, granted?: readonly string[]): { code: string; state: string } {
      const u = new URL(authUrl);
      const code = `code-${++tokenSeq}`;
      codes.set(code, {
        challenge: u.searchParams.get("code_challenge") ?? "",
        client_id: u.searchParams.get("client_id") ?? "",
        redirect: u.searchParams.get("redirect_uri") ?? "",
        scope: (granted ?? (u.searchParams.get("scope") ?? "").split(" ")).join(" "),
      });
      return { code, state: u.searchParams.get("state") ?? "" };
    },
    revokeAccessTokens: () => access.clear(),
    revokeRefreshTokens: () => refresh.clear(),
    tokenRequests: () => requests.filter((r) => r.url.href === TOKEN_URL),
  };
}
