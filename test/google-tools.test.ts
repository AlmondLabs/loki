import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { memorySecrets } from "../daemon/credentials.ts";
import type { ModApi, ModTool } from "../daemon/mods/api.ts";
import { ModRegistry } from "../daemon/mods/registry.ts";
import { Accounts } from "../mod/accounts.ts";
import { GmailClient } from "../mod/gmail.ts";
import { GoogleAuth } from "../mod/google-auth.ts";
import { registerGoogleTools } from "../mod/google-tools/index.ts";
import { fakeWorkspace } from "./fixtures/google.ts";
import { must } from "./fixtures/must.ts";

const WORK = "agent-local-work";
const HOME = "agent-local-home";
const OLD = "agent-local-old";
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ALL = ["gmail", "drive", "sheets", "docs", "calendar"] as const;

/**
 * The Google tools over a fake Workspace: WORK owns ada@acme.com with every service, HOME owns bo@acme.com, OLD owns a
 * mailbox signed in before loki asked for more than Gmail, and far@acme.com lives on a paired Mac. Each tool is called
 * as a chat of an agent, in a chat folder of its own.
 */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "loki-google-tools-"));
  dirs.push(dir);
  const cwd = join(dir, "chat");
  mkdirSync(cwd);
  const now = () => new Date("2026-11-11T09:00:00Z");
  const accounts = new Accounts({ file: join(dir, "accounts.json"), secrets: memorySecrets(), now, agentExists: () => true });
  const secret = JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: "2026-11-12T09:00:00Z" });
  await accounts.add({ account_id: "gmail:ada@acme.com", provider: "gmail", address: "ada@acme.com", owner_agent_id: WORK, services: [...ALL] }, secret);
  await accounts.add({ account_id: "gmail:bo@acme.com", provider: "gmail", address: "bo@acme.com", owner_agent_id: HOME, services: [...ALL] }, secret);
  await accounts.add({ account_id: "gmail:old@acme.com", provider: "gmail", address: "old@acme.com", owner_agent_id: OLD }, secret);
  const ws = fakeWorkspace();
  const auth = (id: string) => new GoogleAuth({ accounts, account_id: id, fetch: ws.fetch, now });
  const tools = new Map<string, ModTool>();
  const mods = new ModRegistry(() => {});
  await mods.load({
    name: "google",
    apiVersion: 1,
    activate: (api: ModApi) =>
      registerGoogleTools(
        { ...api, tools: { register: (t) => (tools.set(t.name, t), api.tools.register(t)) } },
        {
          accounts,
          auth,
          gmail: (id) => new GmailClient({ accounts, account_id: id, auth: auth(id) }),
          heldElsewhere: (id) => (id === "gmail:far@acme.com" ? "the studio Mac" : null),
          resultsDir: (chatId) => join(dir, "tool-results", chatId),
          now,
        },
      ),
  });
  /** A tool's answer as a chat of `agentId`; a refusal comes back as `refused: <why>`. */
  const call = async (agentId: string, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const tool = must(tools.get(name), name);
    try {
      return (await tool.execute(args, {
        chatId: "local-conv-x",
        agentId,
        agentName: agentId,
        signal: new AbortController().signal,
        output: () => {},
        cwd,
      })) as Record<string, unknown>;
    } catch (err) {
      return { refused: err instanceof Error ? err.message : String(err) };
    }
  };
  return { dir, cwd, accounts, ws, tools, mods, call };
}

describe("who may use a Google account (plan 2026-11-11, U7, KTD12)", () => {
  test("every Google tool is script-only, and offered only to an agent that owns a Google account here", async () => {
    const f = await fixture();
    for (const tool of f.tools.values()) {
      expect(tool.callers).toEqual(["tools"]);
      expect(must(tool.forAgent, tool.name)(WORK)).toBe(true);
      expect(must(tool.forAgent, tool.name)("agent-local-nobody")).toBe(false);
    }
    expect([...f.tools.keys()].every((n) => n.startsWith("google_"))).toBe(true);
  });

  test("AE3: a script naming another agent's account is refused, and nothing reaches Google", async () => {
    const f = await fixture();
    expect(await f.call(WORK, "google_drive_list", { account: "bo@acme.com" })).toEqual({
      refused: "bo@acme.com is not this agent's account: only the agent that owns it may use it",
    });
    expect(f.ws.requests).toEqual([]);
  });

  test("AE4: an account connected on a paired Mac is refused as living there", async () => {
    const f = await fixture();
    expect(await f.call(WORK, "google_drive_list", { account: "far@acme.com" })).toEqual({
      refused: "far@acme.com lives on the studio Mac: scripts reach the accounts on this Mac only",
    });
  });

  test("AE5: a mailbox signed in for Gmail alone is told to sign in again for Drive; its Gmail still works", async () => {
    const f = await fixture();
    expect(await f.call(OLD, "google_drive_list")).toEqual({
      refused: "this Google account has not let loki use Drive: sign in again for it in Preferences › Accounts",
    });
    expect(await f.call(OLD, "google_gmail_search", { query: "invoice" })).toMatchObject({ items: expect.any(Array) as unknown });
  });

  test("a disconnected account, or none named when the agent owns two, is refused with the way out", async () => {
    const f = await fixture();
    f.accounts.setStatus("gmail:ada@acme.com", { disconnected: "sign_in_again" });
    expect((await f.call(WORK, "google_drive_list")).refused).toBe("ada@acme.com is disconnected: reconnect it in Preferences › Accounts");
    f.accounts.setStatus("gmail:ada@acme.com", "connected");
    f.accounts.moveOwner("gmail:bo@acme.com", WORK);
    expect((await f.call(WORK, "google_drive_list")).refused).toBe(
      "this agent owns several Google accounts: name one with `account` (ada@acme.com, bo@acme.com)",
    );
    expect(await f.call(WORK, "google_drive_list", { account: "bo@acme.com" })).toMatchObject({ items: expect.any(Array) as unknown });
  });

  test("google_accounts lists the agent's own accounts and their services", async () => {
    const f = await fixture();
    expect(await f.call(OLD, "google_accounts")).toEqual({ accounts: [{ address: "old@acme.com", connected: true, services: ["gmail"] }] });
  });
});

describe("Gmail and Drive for scripts (plan 2026-11-11, U7)", () => {
  test("R19: a search over every page answers a short copy and keeps all 120 threads in the chat's tool-results folder", async () => {
    const f = await fixture();
    const r = await f.call(WORK, "google_gmail_search", { query: "invoice", all_pages: true });
    expect(r.count).toBe(120);
    expect((r.items as unknown[]).length).toBe(20);
    const file = String(r.file);
    expect(file.startsWith(join(f.dir, "tool-results", "local-conv-x"))).toBe(true);
    expect((JSON.parse(readFileSync(file, "utf8")) as unknown[]).length).toBe(120);
    // One page by default, with where the next one starts.
    expect(await f.call(WORK, "google_gmail_search", { query: "invoice" })).toMatchObject({ next_page: "50" });
  });

  test("a thread reads as its messages' senders, text and attachments", async () => {
    const f = await fixture();
    const r = await f.call(WORK, "google_gmail_read", { thread: "t1" });
    expect(r.messages).toEqual([
      expect.objectContaining({
        from: "Billing <billing@example.com>",
        subject: "Your invoice",
        text: "see attached",
        attachments: [{ id: "att1", filename: "invoice.pdf", mime_type: "application/pdf", size: 9 }],
      }),
    ]);
  });

  test("AE10: an attachment goes straight to a Drive folder with its checksum, and no bytes come back to the script", async () => {
    const f = await fixture();
    const r = await f.call(WORK, "google_gmail_attachment", { message: "m1", attachment: "att1", drive_folder: "folder-1" });
    const pdf = Buffer.from("%PDF-1.4\n");
    expect(r).toMatchObject({ name: "invoice.pdf", size: pdf.byteLength, md5: f.ws.md5(pdf) });
    expect(r.drive_file).toMatchObject({ name: "invoice.pdf", parents: ["folder-1"], md5_matches: true });
    expect(JSON.stringify(r)).not.toContain("PDF-1.4");
    expect(f.ws.requests.filter((q) => q.url.pathname.startsWith("/upload/drive"))).toHaveLength(1);
  });

  test("an attachment saved to a path lands in the chat's folder; a path outside it is refused and nothing is written", async () => {
    const f = await fixture();
    const r = await f.call(WORK, "google_gmail_attachment", { message: "m1", attachment: "att1", path: "mail/invoice.pdf" });
    expect(readFileSync(join(f.cwd, "mail", "invoice.pdf"), "utf8")).toBe("%PDF-1.4\n");
    expect(r.path).toBe(join(f.cwd, "mail", "invoice.pdf"));
    expect((await f.call(WORK, "google_gmail_attachment", { message: "m1", attachment: "att1", path: "../escape.pdf" })).refused).toMatch(
      /is outside this chat's folder/,
    );
    expect(readdirSync(f.dir).includes("escape.pdf")).toBe(false);
  });

  test("AE11: archiving through a script changes Gmail's labels only; the Google tools never touch Flow's own moves", async () => {
    const f = await fixture();
    expect(await f.call(WORK, "google_gmail_modify", { threads: ["t1"], archive: true, read: true, add_labels: ["Receipts"] })).toEqual({
      changed: 1,
      added: ["Label_7"],
      removed: ["INBOX", "UNREAD"],
    });
    expect(f.ws.state.modified).toEqual([{ ids: ["m1"], addLabelIds: ["Label_7"], removeLabelIds: ["INBOX", "UNREAD"] }]);
    // Flow sees the change as one made in Gmail (mod/gmail-sync.ts): no Google tool reaches the threads, the moves'
    // ledger, focus learning or the card's waiting mark, which only the person's own actions write.
    const dir = join(import.meta.dirname, "..", "mod", "google-tools");
    for (const file of readdirSync(dir))
      expect(readFileSync(join(dir, file), "utf8"), file).not.toMatch(/from "\.\.\/(account-threads|inbox-ledger|seen|outside-threads|frames\/)/);
  });

  test("R15: a script sends new mail, and a reply in its thread, with a file from the chat's folder", async () => {
    const f = await fixture();
    writeFileSync(join(f.cwd, "notes.txt"), "the numbers");
    expect(
      await f.call(WORK, "google_gmail_send", { to: ["bob@example.com"], subject: "Numbers", body: "attached", attachments: ["notes.txt"] }),
    ).toMatchObject({
      id: "s1",
      thread_id: null,
    });
    expect(await f.call(WORK, "google_gmail_send", { to: ["billing@example.com"], body: "thanks", reply_to: "t1" })).toMatchObject({
      thread_id: "t1",
      subject: "Re: Your invoice",
    });
    const [first, reply] = f.ws.state.sent.map((m) => ({ ...m, text: Buffer.from(m.raw, "base64url").toString("utf8") }));
    expect(must(first, "the new mail").threadId).toBeUndefined();
    expect(must(first, "the new mail").text).toContain("filename*=UTF-8''notes.txt");
    expect(must(reply, "the reply").threadId).toBe("t1");
    expect(must(reply, "the reply").text).toContain("In-Reply-To: <m1@example.com>");
  });

  test("R21: a download and an upload report their checksums against Drive's; a Google Doc is exported", async () => {
    const f = await fixture();
    const down = await f.call(WORK, "google_drive_download", { file: "f1", path: "budget.pdf" });
    expect(down).toMatchObject({ path: join(f.cwd, "budget.pdf"), size: 3, md5_matches: true });
    const up = await f.call(WORK, "google_drive_upload", { path: "budget.pdf", folder: "folder-2" });
    expect(up).toMatchObject({ name: "budget.pdf", parents: ["folder-2"], md5_matches: true });
    const doc = await f.call(WORK, "google_drive_download", { file: "d1", path: "notes.pdf" });
    expect(doc).toMatchObject({ md5_matches: null });
    expect(readFileSync(join(f.cwd, "notes.pdf"), "utf8")).toBe("exported Notes as application/pdf");
  });

  test("Drive changes answer with what Drive stored: a folder, a rename, a move, a copy with both checksums, trash and delete", async () => {
    const f = await fixture();
    const folder = await f.call(WORK, "google_drive_change", { action: "create_folder", name: "Invoices" });
    expect(folder).toMatchObject({ name: "Invoices", mime_type: "application/vnd.google-apps.folder" });
    expect(await f.call(WORK, "google_drive_change", { action: "rename", file: "f1", name: "budget-2026.pdf" })).toMatchObject({ name: "budget-2026.pdf" });
    expect(await f.call(WORK, "google_drive_change", { action: "move", file: "f1", folder: folder.id })).toMatchObject({
      parents: [folder.id],
      md5_matches: true,
    });
    expect(await f.call(WORK, "google_drive_change", { action: "copy", file: "f1", name: "spare.pdf" })).toMatchObject({
      name: "spare.pdf",
      md5_matches: true,
    });
    expect(await f.call(WORK, "google_drive_change", { action: "trash", file: "f1" })).toMatchObject({ trashed: true });
    expect(await f.call(WORK, "google_drive_change", { action: "delete", file: "f1" })).toEqual({ id: "f1", deleted: true });
    expect((await f.call(WORK, "google_drive_change", { action: "delete", file: "f1" })).refused).toBe("File not found: f1.");
  });

  test("no tool answer carries the account's tokens", async () => {
    const f = await fixture();
    const answers = await Promise.all([
      f.call(WORK, "google_accounts"),
      f.call(WORK, "google_gmail_read", { thread: "t1" }),
      f.call(WORK, "google_drive_list"),
      f.call(WORK, "google_sheets_read", { spreadsheet: "s1", ranges: ["A1:A3"] }),
    ]);
    for (const a of answers) expect(JSON.stringify(a)).not.toMatch(/"(a|r)"|access_token|refresh_token|Bearer/);
  });

  test("reads may run again after a restart; writes may not", async () => {
    const f = await fixture();
    const safe = [...f.tools.values()].filter((t) => t.replay === "safe").map((t) => t.name);
    expect(safe.sort()).toEqual(
      [
        "google_accounts",
        "google_calendar_list",
        "google_docs_read",
        "google_drive_download",
        "google_drive_list",
        "google_gmail_read",
        "google_gmail_search",
        "google_sheets_read",
      ].sort(),
    );
  });
});

describe("Sheets, Docs, Calendar and the request tool (plan 2026-11-11, U9)", () => {
  test("AE1: a formula written to one cell is read back with its neighbours, as typed and as computed", async () => {
    const f = await fixture();
    const r = await f.call(WORK, "google_sheets_write", { spreadsheet: "s1", data: [{ range: "Sheet1!A4", values: [["=SUM(A1:A3)"]] }] });
    expect(r.updated_cells).toBe(1);
    expect(r.stored).toEqual([{ range: "Sheet1!A4", values: [["6"]], formulas: [["=SUM(A1:A3)"]] }]);
    const around = await f.call(WORK, "google_sheets_read", { spreadsheet: "s1", ranges: ["Sheet1!A1:A4"], formulas: true });
    expect(around.ranges).toEqual([{ range: "Sheet1!A1:A4", values: [["1"], ["2"], ["3"], ["6"]], formulas: [["1"], ["2"], ["3"], ["=SUM(A1:A3)"]] }]);
    // One write; the read-backs ask for the values as shown and as typed.
    expect(f.ws.requests.filter((q) => q.method === "POST")).toHaveLength(1);
  });

  test("a document reads as text, or as paragraphs with the indexes an edit names", async () => {
    const f = await fixture();
    expect(await f.call(WORK, "google_docs_read", { document: "doc1" })).toEqual({ id: "doc1", title: "Plan", revision: "r1", text: "Title\nFirst line\n" });
    expect((await f.call(WORK, "google_docs_read", { document: "doc1", structure: true })).paragraphs).toEqual([
      { start: 1, end: 7, text: "Title\n", style: "HEADING_1" },
      { start: 7, end: 18, text: "First line\n", style: "NORMAL_TEXT" },
    ]);
  });

  test("an event with two guests is created and they are told; every page of events is listed", async () => {
    const f = await fixture();
    const made = await f.call(WORK, "google_calendar_change", {
      action: "create",
      summary: "Budget review",
      start: "2026-11-12T10:00:00",
      end: "2026-11-12T10:30:00",
      time_zone: "Europe/Berlin",
      guests: ["bob@example.com", "cy@example.com"],
    });
    expect(made).toMatchObject({
      summary: "Budget review",
      guests: [{ email: "bob@example.com" }, { email: "cy@example.com" }].map((g) => ({ ...g, response: "" })),
    });
    const insert = must(
      f.ws.requests.find((q) => q.method === "POST" && q.url.pathname.includes("/calendar/")),
      "the insert",
    );
    expect(insert.url.searchParams.get("sendUpdates")).toBe("all");
    for (const n of [2, 3]) await f.call(WORK, "google_calendar_change", { action: "create", summary: `Meeting ${n}`, start: "2026-11-13", end: "2026-11-14" });
    const all = await f.call(WORK, "google_calendar_list", { from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z", all_pages: true });
    expect(all.count).toBe(3);
  });

  test("the request tool reaches a granted service's own host only", async () => {
    const f = await fixture();
    expect(await f.call(WORK, "google_api", { service: "sheets", method: "POST", path: "/v4/spreadsheets/s1:batchUpdate", body: { requests: [] } })).toEqual({
      replies: [{}],
    });
    expect(f.ws.requests.at(-1)?.url.href).toBe("https://sheets.googleapis.com/v4/spreadsheets/s1:batchUpdate");
    for (const path of ["https://evil.example.com/x", "/v4/../../x", "/drive/v3/files"])
      expect((await f.call(WORK, "google_api", { service: "sheets", method: "GET", path })).refused).toMatch(/is not a path of the sheets API/);
    expect((await f.call(OLD, "google_api", { service: "calendar", method: "GET", path: "/calendar/v3/users/me/calendarList" })).refused).toBe(
      "this Google account has not let loki use Calendar: sign in again for it in Preferences › Accounts",
    );
  });

  test("a Google error rejects with Google's own words", async () => {
    const f = await fixture();
    expect((await f.call(WORK, "google_drive_download", { file: "nope", path: "x.pdf" })).refused).toBe("File not found: nope.");
  });
});
