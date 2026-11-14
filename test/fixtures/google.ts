import { createHash } from "node:crypto";

/**
 * A stand-in for the Google APIs the Google tools call (plan 2026-11-11 scripts, U7), driven through an injected
 * fetch: a few Gmail threads with attachments, a Drive of files, one spreadsheet, one document and a calendar. Any
 * bearer token is taken (GoogleAuth's own tests cover tokens). Every request is recorded, with its body, so a test says
 * what reached Google; nothing here reaches a network.
 */

/** A request the fake received. */
export interface ApiRequest {
  method: string;
  url: URL;
  /** The body as text, or its bytes for an upload. */
  body: string;
  bytes?: Uint8Array;
}

const md5 = (b: Uint8Array | string) => createHash("md5").update(b).digest("hex");

export function fakeWorkspace() {
  const requests: ApiRequest[] = [];
  const state = {
    /** Gmail threads found by any search, served 50 to a page. */
    threads: Array.from({ length: 120 }, (_, i) => ({ id: `t${i + 1}`, snippet: `invoice ${i + 1}` })),
    /** Drive's files, by id. */
    files: new Map<string, { id: string; name: string; mimeType: string; parents: string[]; data?: Uint8Array; trashed?: boolean }>([
      ["f1", { id: "f1", name: "budget.pdf", mimeType: "application/pdf", parents: ["root"], data: new Uint8Array([1, 2, 3]) }],
      ["d1", { id: "d1", name: "Notes", mimeType: "application/vnd.google-apps.document", parents: ["root"] }],
    ]),
    /** The spreadsheet's cells, as typed. */
    cells: new Map<string, string>([
      ["A1", "1"],
      ["A2", "2"],
      ["A3", "3"],
    ]),
    events: [] as Array<Record<string, unknown>>,
    sent: [] as Array<{ raw: string; threadId?: string }>,
    modified: [] as Array<Record<string, unknown>>,
    nextId: 1,
    /** Answer each read of message m1 with a new attachment id, as Gmail does. */
    freshAttachmentIds: false,
  };
  const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const fileJson = (f: { id: string; name: string; mimeType: string; parents: string[]; data?: Uint8Array; trashed?: boolean }) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    parents: f.parents,
    modifiedTime: "2026-11-11T09:00:00.000Z",
    ...(f.data ? { size: String(f.data.byteLength), md5Checksum: md5(f.data) } : {}),
    ...(f.trashed ? { trashed: true } : {}),
  });
  /** A cell's shown value: a formula computed (only SUM of a column range), anything else as typed. */
  const shown = (typed: string): string => {
    const sum = /^=SUM\(A(\d+):A(\d+)\)$/.exec(typed);
    if (!sum) return typed;
    let total = 0;
    for (let r = Number(sum[1]); r <= Number(sum[2]); r++) total += Number(state.cells.get(`A${r}`) ?? 0);
    return String(total);
  };
  /** The cells of a range like "Sheet1!A1:B3" or "A4". */
  const cellsOf = (range: string): string[][] => {
    const [from = "A1", to = from] = range.replace(/^.*!/, "").split(":");
    const col = (c: string) => c.charCodeAt(0) - 64;
    const [fc, fr] = [col(from.charAt(0) || "A"), Number(from.slice(1))];
    const [tc, tr] = [col(to.charAt(0) || "A"), Number(to.slice(1))];
    const rows: string[][] = [];
    for (let r = fr; r <= tr; r++) {
      const row: string[] = [];
      for (let c = fc; c <= tc; c++) row.push(`${String.fromCharCode(64 + c)}${r}`);
      rows.push(row);
    }
    return rows;
  };
  const MESSAGE = {
    id: "m1",
    threadId: "t1",
    labelIds: ["INBOX", "UNREAD"],
    snippet: "invoice attached",
    historyId: "1",
    internalDate: "1793000000000",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Billing <billing@example.com>" },
        { name: "To", value: "ada@acme.com" },
        { name: "Subject", value: "Your invoice" },
        { name: "Message-ID", value: "<m1@example.com>" },
      ],
      body: { size: 0 },
      parts: [
        {
          partId: "0",
          mimeType: "text/plain",
          filename: "",
          headers: [],
          body: { size: 12, data: Buffer.from("see attached").toString("base64url") },
          parts: [],
        },
        { partId: "1", mimeType: "application/pdf", filename: "invoice.pdf", headers: [], body: { size: 9, attachmentId: "att1" }, parts: [] },
      ],
    },
  };

  const route = (req: ApiRequest): Response => {
    const { url, method } = req;
    const p = url.pathname;
    const gmail = /^\/gmail\/v1\/users\/me(.*)$/.exec(p)?.[1];
    if (url.host === "gmail.googleapis.com" && gmail !== undefined) {
      if (gmail === "/threads" && method === "GET") {
        const from = Number(url.searchParams.get("pageToken") ?? "0");
        const page = state.threads.slice(from, from + 50);
        return json(200, { threads: page, ...(from + 50 < state.threads.length ? { nextPageToken: String(from + 50) } : {}) });
      }
      if (/^\/threads\/[^/]+$/.test(gmail)) return json(200, { id: "t1", historyId: "1", messages: [MESSAGE] });
      // Gmail gives an attachment a new id each time the message is read, as the real API does (state.freshAttachmentIds).
      if (gmail === "/messages/m1")
        return json(
          200,
          state.freshAttachmentIds ? JSON.parse(JSON.stringify(MESSAGE).replace('"attachmentId":"att1"', `"attachmentId":"att1-${state.nextId++}"`)) : MESSAGE,
        );
      if (gmail.startsWith("/messages/m1/attachments/att1")) return json(200, { data: Buffer.from("%PDF-1.4\n").toString("base64url") });
      if (gmail === "/messages/batchModify") {
        state.modified.push(JSON.parse(req.body) as Record<string, unknown>);
        return new Response(null, { status: 204 });
      }
      if (gmail === "/labels") return json(200, { labels: [{ id: "Label_7", name: "Receipts", type: "user" }] });
      if (gmail === "/messages/send") {
        const m = JSON.parse(req.body) as { raw: string; threadId?: string };
        state.sent.push(m);
        return json(200, { id: `s${state.sent.length}`, threadId: m.threadId ?? `new${state.sent.length}` });
      }
    }
    // A message with files comes through Gmail's upload route (plan 2026-11-14-1134, KTD6): a JSON part with its
    // thread, then the message itself. It is kept as the JSON route keeps one, so a test reads both alike.
    if (url.host === "gmail.googleapis.com" && p === "/upload/gmail/v1/users/me/messages/send") {
      const text = req.bytes ? Buffer.from(req.bytes).toString("utf8") : req.body;
      const meta = JSON.parse(/\{.*\}/.exec(text)?.[0] ?? "{}") as { threadId?: string };
      const message = /message\/rfc822\r\n\r\n([\s\S]*)\r\n--[^\r\n]+--/.exec(text)?.[1] ?? "";
      const m = { raw: Buffer.from(message, "utf8").toString("base64url"), ...(meta.threadId ? { threadId: meta.threadId } : {}) };
      state.sent.push(m);
      return json(200, { id: `s${state.sent.length}`, threadId: m.threadId ?? `new${state.sent.length}` });
    }
    if (url.host === "www.googleapis.com" && p.startsWith("/upload/drive/v3/files")) {
      const id = `up${state.nextId++}`;
      const text = req.bytes ? Buffer.from(req.bytes).toString("latin1") : req.body;
      const meta = JSON.parse(/\{.*\}/.exec(text)?.[0] ?? "{}") as { name?: string; parents?: string[] };
      const boundary = /boundary=(\S+)/.exec(text) ?? /--(loki-[0-9a-f]+)/.exec(text);
      const parts = boundary ? text.split(`--${boundary[1]}`) : [];
      const content = (parts[2] ?? "").replace(/^[\s\S]*?\r\n\r\n/, "").replace(/\r\n$/, "");
      const file = {
        id,
        name: meta.name ?? "untitled",
        mimeType: "application/pdf",
        parents: meta.parents ?? ["root"],
        data: new Uint8Array(Buffer.from(content, "latin1")),
      };
      state.files.set(id, file);
      return json(200, fileJson(file));
    }
    const drive = /^\/drive\/v3\/files(?:\/([^/]+))?(\/copy|\/export)?$/.exec(p);
    if (url.host === "www.googleapis.com" && drive) {
      const [, id, suffix] = drive;
      if (!id && method === "GET") {
        const all = [...state.files.values()];
        return json(200, { files: all.map(fileJson) });
      }
      if (!id && method === "POST") {
        const body = JSON.parse(req.body) as { name: string; mimeType: string; parents?: string[] };
        const file = { id: `n${state.nextId++}`, name: body.name, mimeType: body.mimeType, parents: body.parents ?? ["root"] };
        state.files.set(file.id, file);
        return json(200, fileJson(file));
      }
      const file = id ? state.files.get(decodeURIComponent(id)) : undefined;
      if (!file) return json(404, { error: { code: 404, message: `File not found: ${id}.` } });
      if (suffix === "/export") return new Response(`exported ${file.name} as ${url.searchParams.get("mimeType") ?? ""}`);
      if (suffix === "/copy") {
        const copy = { ...file, id: `c${state.nextId++}`, name: (JSON.parse(req.body) as { name?: string }).name ?? `Copy of ${file.name}` };
        state.files.set(copy.id, copy);
        return json(200, fileJson(copy));
      }
      if (method === "GET" && url.searchParams.get("alt") === "media") return new Response((file.data ?? new Uint8Array()).slice());
      if (method === "GET") return json(200, fileJson(file));
      if (method === "DELETE") {
        state.files.delete(file.id);
        return new Response(null, { status: 204 });
      }
      if (method === "PATCH") {
        const body = JSON.parse(req.body || "{}") as { name?: string; trashed?: boolean };
        const add = url.searchParams.get("addParents");
        const next = { ...file, ...(body.name ? { name: body.name } : {}), ...(body.trashed ? { trashed: true } : {}), ...(add ? { parents: [add] } : {}) };
        state.files.set(file.id, next);
        return json(200, fileJson(next));
      }
    }
    if (url.host === "sheets.googleapis.com") {
      if (p.endsWith("/values:batchUpdate")) {
        const body = JSON.parse(req.body) as { data: Array<{ range: string; values: unknown[][] }> };
        let n = 0;
        for (const d of body.data)
          cellsOf(d.range).forEach((row, r) =>
            row.forEach((cell, c) => {
              const v = d.values[r]?.[c];
              if (v !== undefined) {
                state.cells.set(cell, typeof v === "string" || typeof v === "number" ? String(v) : JSON.stringify(v));
                n++;
              }
            }),
          );
        return json(200, { totalUpdatedCells: n });
      }
      if (p.endsWith("/values:batchGet")) {
        const formulas = url.searchParams.get("valueRenderOption") === "FORMULA";
        return json(200, {
          valueRanges: url.searchParams.getAll("ranges").map((range) => ({
            range,
            values: cellsOf(range).map((row) => row.map((cell) => (formulas ? (state.cells.get(cell) ?? "") : shown(state.cells.get(cell) ?? "")))),
          })),
        });
      }
      if (p.endsWith(":batchUpdate")) return json(200, { replies: [{}] });
    }
    if (url.host === "docs.googleapis.com" && p.startsWith("/v1/documents/"))
      return json(200, {
        documentId: "doc1",
        title: "Plan",
        revisionId: "r1",
        body: {
          content: [
            { startIndex: 1, endIndex: 7, paragraph: { elements: [{ textRun: { content: "Title\n" } }], paragraphStyle: { namedStyleType: "HEADING_1" } } },
            {
              startIndex: 7,
              endIndex: 18,
              paragraph: { elements: [{ textRun: { content: "First line\n" } }], paragraphStyle: { namedStyleType: "NORMAL_TEXT" } },
            },
          ],
        },
      });
    const cal = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(p);
    if (url.host === "www.googleapis.com" && cal) {
      if (method === "GET") {
        const from = Number(url.searchParams.get("pageToken") ?? "0");
        return json(200, { items: state.events.slice(from, from + 2), ...(from + 2 < state.events.length ? { nextPageToken: String(from + 2) } : {}) });
      }
      if (method === "POST") {
        const event = { id: `e${state.nextId++}`, status: "confirmed", ...(JSON.parse(req.body) as Record<string, unknown>) };
        state.events.push(event);
        return json(200, event);
      }
    }
    if (url.host === "www.googleapis.com" && p === "/calendar/v3/users/me/calendarList") return json(200, { items: [{ id: "primary" }] });
    return json(404, { error: { code: 404, message: "Not Found" } });
  };

  const fetchFn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const raw = init?.body;
    const req: ApiRequest = {
      method: init?.method ?? "GET",
      url,
      body: typeof raw === "string" ? raw : raw instanceof Uint8Array ? Buffer.from(raw).toString("latin1") : "",
      ...(raw instanceof Uint8Array ? { bytes: raw } : {}),
    };
    requests.push(req);
    return Promise.resolve(route(req));
  };

  return { fetch: fetchFn, requests, state, md5 };
}
