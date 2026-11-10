/**
 * A Gmail mailbox that changes, behind an injected fetch (plan 067, U5): messages with labels and dates, a history
 * that records each delivery and label change, a search that understands the parts of Gmail's query the watcher sends
 * (`is:unread`, `in:inbox`, `after:` and `before:` in seconds), threads, label changes by message both ways, and the account's labels. A thread named in `state.unreadable` answers 400, and every label change answers 403 with `state.refuseModify` while it is set. Any bearer token is taken:
 * test/fixtures/gmail.ts covers the tokens; this covers what the mailbox holds. Every request is recorded.
 */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const PAGE = 100;

interface Stored {
  id: string;
  threadId: string;
  labels: Set<string>;
  at: number;
  headers: Record<string, string>;
  snippet: string;
}

interface HistoryEntry {
  id: number;
  messagesAdded?: Array<{ message: { id: string; threadId: string; labelIds: string[] } }>;
  labelsAdded?: Array<{ message: { id: string; threadId: string; labelIds: string[] }; labelIds: string[] }>;
  labelsRemoved?: Array<{ message: { id: string; threadId: string; labelIds: string[] }; labelIds: string[] }>;
}

/** The labels every mailbox answers with: Gmail's own and two the person made. */
const LABELS = [
  { id: "INBOX", name: "INBOX", type: "system" },
  { id: "UNREAD", name: "UNREAD", type: "system" },
  { id: "STARRED", name: "STARRED", type: "system" },
  { id: "Label_1", name: "Receipts", type: "user" },
  { id: "Label_2", name: "Travel", type: "user" },
];

/** A mail to deliver: its thread, when it came, and its headers; INBOX and UNREAD unless `labels` says otherwise. */
export interface Delivery {
  thread: string;
  at: Date;
  from: string;
  to?: string;
  cc?: string;
  subject?: string;
  headers?: Record<string, string>;
  snippet?: string;
  labels?: string[];
}

/** A mailbox for `email`, with its send-as aliases. */
export function fakeMailbox(opts: { email?: string; sendAs?: string[] } = {}) {
  const email = opts.email ?? "ada@acme.com";
  const messages = new Map<string, Stored>();
  const history: HistoryEntry[] = [];
  const requests: Array<{ method: string; url: URL }> = [];
  const state = {
    historyId: 100,
    oldestHistoryId: 0,
    seq: 0,
    failing: false,
    unreadable: new Set<string>(),
    refuseModify: null as string | null,
    inboxListings: 0,
  };

  const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const view = (m: Stored) => ({ id: m.id, threadId: m.threadId, labelIds: [...m.labels] });
  const full = (m: Stored) => ({
    ...view(m),
    snippet: m.snippet,
    historyId: String(state.historyId),
    internalDate: String(m.at),
    payload: {
      mimeType: "text/plain",
      filename: "",
      headers: Object.entries(m.headers).map(([name, value]) => ({ name, value })),
      body: { size: 0 },
      parts: [],
    },
  });

  const search = (q: string): Stored[] => {
    const terms = q.split(/\s+/).filter(Boolean);
    const num = (prefix: string) => {
      const t = terms.find((x) => x.startsWith(prefix));
      return t ? Number(t.slice(prefix.length)) * 1000 : null;
    };
    const after = num("after:");
    const before = num("before:");
    return [...messages.values()]
      .filter((m) => !terms.includes("is:unread") || m.labels.has("UNREAD"))
      .filter((m) => !terms.includes("in:inbox") || m.labels.has("INBOX"))
      .filter((m) => (after === null || m.at >= after) && (before === null || m.at < before))
      .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
  };

  const removeLabels = (ids: string[], labels: string[]) => {
    const changed: NonNullable<HistoryEntry["labelsRemoved"]> = [];
    for (const id of ids) {
      const m = messages.get(id);
      if (!m) continue;
      const gone = labels.filter((l) => m.labels.has(l));
      for (const l of gone) m.labels.delete(l);
      if (gone.length) changed.push({ message: view(m), labelIds: gone });
    }
    if (changed.length) history.push({ id: ++state.historyId, labelsRemoved: changed });
  };

  const addLabels = (ids: string[], labels: string[]) => {
    const changed: NonNullable<HistoryEntry["labelsAdded"]> = [];
    for (const id of ids) {
      const m = messages.get(id);
      if (!m) continue;
      const fresh = labels.filter((l) => !m.labels.has(l));
      for (const l of fresh) m.labels.add(l);
      if (fresh.length) changed.push({ message: view(m), labelIds: fresh });
    }
    if (changed.length) history.push({ id: ++state.historyId, labelsAdded: changed });
  };

  const answer = (method: string, url: URL, body: string): Response => {
    if (state.failing) return json(503, { error: { code: 503, message: "Backend Error" } });
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    const q = url.searchParams;
    if (path === "/profile") return json(200, { emailAddress: email, historyId: String(state.historyId) });
    if (path === "/settings/sendAs") return json(200, { sendAs: [email, ...(opts.sendAs ?? [])].map((a) => ({ sendAsEmail: a })) });
    if (path === "/history") {
      const start = Number(q.get("startHistoryId"));
      if (start < state.oldestHistoryId) return json(404, { error: { code: 404, message: "Requested entity was not found." } });
      return json(200, { history: history.filter((h) => h.id > start).map((h) => ({ ...h, id: String(h.id) })), historyId: String(state.historyId) });
    }
    if (path === "/messages") {
      const found = search(q.get("q") ?? "");
      const from = Number(q.get("pageToken") ?? "0");
      const next = from + PAGE < found.length ? String(from + PAGE) : undefined;
      return json(200, { messages: found.slice(from, from + PAGE).map((m) => ({ id: m.id, threadId: m.threadId })), ...(next ? { nextPageToken: next } : {}) });
    }
    if (path === "/threads" && q.get("labelIds") === "INBOX") {
      // The inbox's threads, newest first by their newest message, as Gmail lists them (plan 088).
      const newest = new Map<string, number>();
      for (const m of messages.values()) newest.set(m.threadId, Math.max(newest.get(m.threadId) ?? 0, m.at));
      const inbox = [...new Set([...messages.values()].filter((m) => m.labels.has("INBOX")).map((m) => m.threadId))].sort(
        (a, b) => (newest.get(b) ?? 0) - (newest.get(a) ?? 0) || b.localeCompare(a),
      );
      state.inboxListings++;
      const from = Number(q.get("pageToken") ?? "0");
      const next = from + PAGE < inbox.length ? String(from + PAGE) : undefined;
      return json(200, { threads: inbox.slice(from, from + PAGE).map((id) => ({ id })), ...(next ? { nextPageToken: next } : {}) });
    }
    const thread = /^\/threads\/([^/]+)$/.exec(path);
    if (thread && method === "GET") {
      const id = decodeURIComponent(thread[1]);
      if (state.unreadable.has(id)) return json(400, { error: { code: 400, message: "Invalid thread", errors: [{ reason: "invalidArgument" }] } });
      const list = [...messages.values()].filter((m) => m.threadId === id).sort((a, b) => a.at - b.at);
      if (!list.length) return json(404, { error: { code: 404, message: "Requested entity was not found." } });
      return json(200, { id, historyId: String(state.historyId), messages: list.map(full) });
    }
    if (path === "/messages/batchModify" && method === "POST") {
      if (state.refuseModify !== null) return json(403, { error: { code: 403, message: state.refuseModify, errors: [{ reason: "insufficientPermissions" }] } });
      const { ids, addLabelIds, removeLabelIds } = JSON.parse(body) as { ids: string[]; addLabelIds?: string[]; removeLabelIds?: string[] };
      addLabels(ids, addLabelIds ?? []);
      removeLabels(ids, removeLabelIds ?? []);
      return new Response(null, { status: 204 });
    }
    if (path === "/labels" && method === "GET") return json(200, { labels: LABELS });
    return json(404, { error: { code: 404, message: "Not Found" } });
  };

  const fetchFn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    requests.push({ method, url });
    if (!url.href.startsWith(API)) return Promise.resolve(json(404, {}));
    return Promise.resolve(answer(method, url, typeof init?.body === "string" ? init.body : ""));
  };

  return {
    fetch: fetchFn,
    requests,
    state,
    /** A mail arrives; returns its id. */
    deliver(d: Delivery): string {
      const id = `m${String(++state.seq).padStart(5, "0")}`;
      const headers: Record<string, string> = { From: d.from, Subject: d.subject ?? "hello", ...d.headers };
      if (d.to !== undefined) headers.To = d.to;
      if (d.cc !== undefined) headers.Cc = d.cc;
      const m: Stored = {
        id,
        threadId: d.thread,
        labels: new Set(d.labels ?? ["INBOX", "UNREAD"]),
        at: d.at.getTime(),
        headers,
        snippet: d.snippet ?? `${d.subject ?? "hello"} from ${d.from}`,
      };
      messages.set(id, m);
      history.push({ id: ++state.historyId, messagesAdded: [{ message: view(m) }] });
      return id;
    },
    /** The person reads (or archives, with INBOX) a thread in Gmail itself. */
    removeLabels: (thread: string, labels: string[]) =>
      removeLabels(
        [...messages.values()].filter((m) => m.threadId === thread).map((m) => m.id),
        labels,
      ),
    /** The person moves a thread's mail back into the inbox, or labels it, in Gmail itself. */
    addLabels: (thread: string, labels: string[]) =>
      addLabels(
        [...messages.values()].filter((m) => m.threadId === thread).map((m) => m.id),
        labels,
      ),
    /** Gmail forgets the history so far: a history call from before now answers 404. */
    expireHistory: () => {
      state.oldestHistoryId = ++state.historyId;
      history.length = 0;
    },
    /** The mailbox's newest history id, as its profile says it. */
    historyId: () => String(state.historyId),
    /** How many inbox listings loki asked for (plan 088), so a test can tell a tick that listed from one that did not. */
    inboxListings: () => state.inboxListings,
    /** One message's labels, sorted. */
    labelsOfMessage: (id: string) => [...(messages.get(id)?.labels ?? [])].sort(),
    labelsOf: (thread: string) => [...new Set([...messages.values()].filter((m) => m.threadId === thread).flatMap((m) => [...m.labels]))].sort(),
  };
}
