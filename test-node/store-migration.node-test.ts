/**
 * Plans 044 and 045: saved chats take the shapes loki writes now, loki's tool names and none of Letta's, once per store,
 * copied first; a chat on an ACP agent keeps its agent's. Runs under Node (the store is `node:sqlite`): npm run test:node
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { StoreManager } from "../daemon/kernel/stores.ts";
import { STORE_VERSION, migrateStoredEntries, withoutLettaText } from "../daemon/store-migration.ts";
import { trialRegistry } from "./trial-registry.ts";

const ctx = BACKGROUND_CONTEXT;

const call = (id: string, name: string, args: object) =>
  JSON.stringify({ kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] }] });
const result = (id: string, name: string) =>
  JSON.stringify({ kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "ok" }] }] });
const user = (text: string) => JSON.stringify({ kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text }] }] });

/** The rows a store's renaming reads, in conversations 1 (loki's engine) and 2 (an ACP agent's). */
const ROWS: Array<[number, string]> = [
  [1, call("t1", "tasks", { action: "create", title: "rotate keys" })],
  [1, result("t1", "tasks")],
  [1, call("d1", "desk_state", {})],
  [1, result("d1", "desk_state")],
  [1, call("q1", "AskUserQuestion", { questions: [] })],
  [1, call("b1", "background_run", { command: "ls" })],
  [1, call("x1", "tasks", { action: "fly" })],
  [2, call("s1", "Skill", { skill: "plan" })],
  [2, result("s1", "Skill")],
];

const records = (file: string): string[] => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("SELECT record FROM entries ORDER BY id").all() as Array<{ record: string }>).map((r) => r.record);
  } finally {
    db.close();
  }
};

/** A store with the one table the renaming reads. */
function table(file: string, rows: Array<[number, string]>): void {
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, head INTEGER, commit_seq INTEGER NOT NULL DEFAULT 0, record TEXT NOT NULL)",
  );
  const insert = db.prepare("INSERT INTO entries (conversation_id, commit_seq, record) VALUES (?, 0, ?)");
  for (const [conversation, record] of rows) insert.run(conversation, record);
  db.close();
}

void test("calls and results take the names now, a split tool's by its action; an ACP chat and current names stay; copied first", () => {
  const dir = mkdtempSync(join(tmpdir(), "loki-store-migration-"));
  try {
    const file = join(dir, "agent.sqlite");
    table(file, ROWS);
    const before = records(file);
    const report = migrateStoredEntries(file, new Set([2]), join(dir, "backup"));
    assert.equal(report.entries, 5);
    assert.equal(report.backup, join(dir, "backup", "agent.sqlite"));
    assert.deepEqual(records(report.backup), before);
    const after = records(file);
    assert.equal(after[0], call("t1", "task_create", { title: "rotate keys" }));
    assert.equal(after[1], result("t1", "task_create"));
    assert.equal(after[2], call("d1", "canvas_read", {}));
    assert.equal(after[3], result("d1", "canvas_read"));
    assert.equal(after[4], call("q1", "user_ask", { questions: [] }));
    // A current name, an action the old tool never had, and the ACP agent's own names are as they were.
    assert.deepEqual(after.slice(5), before.slice(5));
    // Again: nothing left to rename, and no second copy.
    assert.deepEqual(migrateStoredEntries(file, new Set([2]), join(dir, "backup2")), { entries: 0, backup: null });
    assert.equal(existsSync(join(dir, "backup2")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("the daemon's store manager renames a store once as it opens it, and leaves its Claude Code chats as they are", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loki-store-migration-"));
  const options = { models: createModels(), registry: trialRegistry() };
  const first = new StoreManager(dir, options, ctx);
  const file = first.file("agent-local-a");
  let loki = 0;
  let claude = 0;
  try {
    const store = await first.get("agent-local-a");
    loki = (await store.createChat("c-loki", { title: "on loki" }, ctx)).id;
    claude = (await store.createChat("c-claude", { title: "on Claude Code" }, ctx)).id;
    await store.updateChat("c-claude", { engine: { kind: "acp", agent: "claude", model: "default", session_id: null } }, ctx);
  } finally {
    await first.closeAll();
  }
  // A new store is noted as at the version now when it first opens. Forget that (below), and add calls under old names,
  // as a store from before plan 044 has them.
  table(file, [
    [loki, call("d1", "desk_state", {})],
    [claude, call("s1", "Skill", { skill: "plan" })],
  ]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "migrations.json"), "utf8")), { "agent-local-a.sqlite": STORE_VERSION });
  rmSync(join(dir, "migrations.json"));
  const reports: string[] = [];
  const second = new StoreManager(dir, options, ctx, (m) => reports.push(m));
  try {
    await second.get("agent-local-a");
    const after = records(file).filter((r) => r.includes('"toolCall"'));
    assert.deepEqual(after, [call("d1", "canvas_read", {}), call("s1", "Skill", { skill: "plan" })]);
    assert.equal(reports.length, 1);
    assert.match(reports[0], /1 saved entries rewritten as loki writes them now, copied first to .*backup-letta-.*agent-local-a\.sqlite/);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "migrations.json"), "utf8")), { "agent-local-a.sqlite": STORE_VERSION });
  } finally {
    await second.closeAll();
  }
  // Opened again, it is not read through again.
  const third = new StoreManager(dir, options, ctx, (m) => reports.push(m));
  try {
    await third.get("agent-local-a");
    assert.equal(reports.length, 1);
  } finally {
    await third.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("Letta's notes are loki's reminders, its transcript pointer goes, and its background notice is the bare command", () => {
  assert.equal(withoutLettaText("hi <system-alert>low memory</system-alert>"), "hi <system-reminder>low memory</system-reminder>");
  assert.equal(withoutLettaText('<channel-notification from="slack">ping</channel-notification>'), "<system-reminder>ping</system-reminder>");
  const alert = '{"type":"system_alert","message":"38 messages hidden"}';
  assert.equal(withoutLettaText(alert), `<system-reminder>${alert}</system-reminder>`);
  assert.equal(withoutLettaText("done\nFull transcript available at: /Users/x/.letta/t.log\nok"), "done\n\nok");
  assert.equal(
    withoutLettaText('<task-notification>\n<summary>Background command "Re-auth dev" completed</summary>\n</task-notification>'),
    "<task-notification>\n<summary>Re-auth dev</summary>\n</task-notification>",
  );
  // A second pass changes nothing.
  for (const t of ["hi <system-alert>low</system-alert>", alert]) assert.equal(withoutLettaText(withoutLettaText(t)), withoutLettaText(t));
});

void test("Letta's shapes in a store: cmd becomes command, multiSelect multi_select, ~/.letta/loki ~/.loki; an ACP chat's stay", () => {
  const dir = mkdtempSync(join(tmpdir(), "loki-store-migration-"));
  try {
    const file = join(dir, "agent.sqlite");
    const question = { questions: [{ question: "Which?", options: [{ label: "a" }], multiSelect: true }] };
    table(file, [
      [1, call("e1", "exec_command", { cmd: "ls /Users/x/.letta/loki/widgets", workdir: "/tmp" })],
      [1, call("q1", "AskUserQuestion", question)],
      [1, user("look\n<system-alert>note</system-alert>")],
      [1, result("r1", "bash")],
      [2, call("e2", "exec_command", { cmd: "ls" })],
    ]);
    const before = records(file);
    assert.equal(migrateStoredEntries(file, new Set([2]), join(dir, "backup")).entries, 3);
    const after = records(file);
    assert.equal(after[0], call("e1", "exec_command", { command: "ls /Users/x/.loki/widgets", workdir: "/tmp" }));
    assert.equal(after[1], call("q1", "user_ask", { questions: [{ question: "Which?", options: [{ label: "a" }], multi_select: true }] }));
    assert.equal(after[2], user("look\n<system-reminder>note</system-reminder>"));
    assert.deepEqual(after.slice(3), before.slice(3));
    assert.equal(migrateStoredEntries(file, new Set([2]), join(dir, "backup2")).entries, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
