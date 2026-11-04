import { createHash } from "node:crypto";

/**
 * A stand-in for Google's token endpoint and the Gmail API, driven through an injected fetch (plan 067, U4). It keeps
 * the codes the authorization page would have issued, bound to their PKCE challenge, client and redirect; the tokens it
 * issued, each with its expiry on the test's clock; and a small mailbox. Every request is recorded, so a test can say
 * which endpoints were reached and with what.
 */

/** A request the fake received: its method, URL and body as text. */
export interface FakeRequest {
  method: string;
  url: URL;
  body: string;
}

interface Code {
  challenge: string;
  client_id: string;
  redirect: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Google and one Gmail mailbox, on the test's clock. */
export function fakeGoogle(opts: { now: () => Date; email?: string }) {
  const email = opts.email ?? "ada@acme.com";
  const codes = new Map<string, Code>();
  const access = new Map<string, { expires: number; client_id: string }>();
  const refresh = new Map<string, string>();
  const requests: FakeRequest[] = [];
  const drafts: Array<{ raw: string; threadId: string }> = [];
  const modified: Array<{ threadId: string; removeLabelIds: unknown }> = [];
  const state = {
    /** History older than this id is gone: a history call from before it is 404. */
    oldestHistoryId: 100,
    /** The history records, served two to a page. */
    history: [] as Array<{ id: string; messagesAdded: Array<{ message: { id: string; threadId: string } }> }>,
    historyId: "500",
    /** What /settings/sendAs answers: the addresses, or a status to refuse with. */
    sendAs: ["ada@acme.com", "ada@example.org"] as string[] | number,
    /** A Workspace admin has stopped the app: every call is refused with Google's reason. */
    adminBlocked: false,
  };
  /** Every token issued, in order, so a test can name the ones a sign-in kept. */
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
      refresh.set(refreshToken, code.client_id);
      issued.refresh.push(refreshToken);
      return json(200, { access_token: issue(code.client_id), refresh_token: refreshToken, expires_in: 3600, token_type: "Bearer" });
    }
    if (form.get("grant_type") === "refresh_token") {
      if (state.adminBlocked) return json(400, { error: "admin_policy_enforced" });
      const client = refresh.get(form.get("refresh_token") ?? "");
      if (!client || client !== form.get("client_id")) return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
      return json(200, { access_token: issue(client), expires_in: 3600, token_type: "Bearer" });
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
    if (path === "/profile") return json(200, { emailAddress: email, historyId: state.historyId });
    if (path === "/settings/sendAs")
      return typeof state.sendAs === "number"
        ? json(state.sendAs, { error: { code: state.sendAs, message: "Insufficient Permission", errors: [{ reason: "insufficientPermissions" }] } })
        : json(200, { sendAs: state.sendAs.map((a) => ({ sendAsEmail: a })) });
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
    const modify = /^\/threads\/([^/]+)\/modify$/.exec(path);
    if (modify && req.method === "POST") {
      modified.push({ threadId: modify[1], removeLabelIds: (JSON.parse(req.body) as { removeLabelIds: unknown }).removeLabelIds });
      return json(200, { id: modify[1] });
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
    modified,
    state,
    /** The person approves on Google's page: a code bound to the URL's challenge, client and redirect. */
    authorize(authUrl: string): { code: string; state: string } {
      const u = new URL(authUrl);
      const code = `code-${++tokenSeq}`;
      codes.set(code, {
        challenge: u.searchParams.get("code_challenge") ?? "",
        client_id: u.searchParams.get("client_id") ?? "",
        redirect: u.searchParams.get("redirect_uri") ?? "",
      });
      return { code, state: u.searchParams.get("state") ?? "" };
    },
    /** Google stops honouring every access token it issued, before their time (a password change, a reset). */
    revokeAccessTokens: () => access.clear(),
    /** The person revoked loki's access: every refresh token is refused with invalid_grant. */
    revokeRefreshTokens: () => refresh.clear(),
    /** Requests to the token endpoint. */
    tokenRequests: () => requests.filter((r) => r.url.href === TOKEN_URL),
  };
}
