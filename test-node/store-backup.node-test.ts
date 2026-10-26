/**
 * Plan 039: a chat store is copied whole before a newer pi-durable migrates its schema, for good. Runs under Node (the
 * store is `node:sqlite`): npm run test:node
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { applySqliteMigrations, CURRENT_SQLITE_SCHEMA_VERSION, SQLITE_MIGRATIONS } from "@earendil-works/pi-durable/storage/sqlite";
import { StoreManager } from "../daemon/kernel/stores.ts";
import { backupBeforeMigration } from "../daemon/store-backup.ts";
import { trialRegistry } from "./trial-registry.ts";

const ctx = BACKGROUND_CONTEXT;
const day = new Date("2026-10-26T12:00:00Z");

/** A store as pi-durable 1.1 left it: its first schema only, version 1. */
async function storeAtVersion1(file: string): Promise<void> {
  const db = await openNodeSqliteDatabase(file);
  await applySqliteMigrations(db, SQLITE_MIGRATIONS.slice(0, 1));
  await db.close();
}
const versionOf = (file: string): number => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get() as { version: number }).version;
  } finally {
    db.close();
  }
};

void test("a store on an older schema is copied before it migrates; the copy stays as it was, and is made once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loki-backup-"));
  try {
    const file = join(dir, "agent-local-a.sqlite");
    await storeAtVersion1(file);
    assert.ok(CURRENT_SQLITE_SCHEMA_VERSION > 1);
    const copy = backupBeforeMigration(file, CURRENT_SQLITE_SCHEMA_VERSION, day);
    assert.equal(copy, join(dir, "backup-schema-1-2026-10-26", "agent-local-a.sqlite"));
    assert.equal(versionOf(copy), 1);
    // Asked again the same day (a store that failed to open, say), the first copy is kept.
    assert.equal(backupBeforeMigration(file, CURRENT_SQLITE_SCHEMA_VERSION, day), copy);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("a store already on the current schema, a missing file, and a file pi-durable never set up are not copied", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loki-backup-"));
  try {
    const file = join(dir, "s.sqlite");
    await storeAtVersion1(file);
    assert.equal(backupBeforeMigration(file, 1, day), null);
    assert.equal(backupBeforeMigration(join(dir, "none.sqlite"), CURRENT_SQLITE_SCHEMA_VERSION, day), null);
    const other = join(dir, "other.sqlite");
    new DatabaseSync(other).close();
    assert.equal(backupBeforeMigration(other, CURRENT_SQLITE_SCHEMA_VERSION, day), null);
    assert.equal(existsSync(join(dir, "backup-schema-1-2026-10-26")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("the daemon's store manager copies a version-1 store, then pi-durable migrates it and it works", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loki-backup-"));
  const reports: string[] = [];
  const stores = new StoreManager(dir, { models: createModels(), registry: trialRegistry() }, ctx, (m) => reports.push(m));
  try {
    const file = stores.file("agent-local-a");
    await storeAtVersion1(file);
    const store = await stores.get("agent-local-a");
    await store.createChat("c1", { title: "kept" }, ctx);
    assert.equal(versionOf(file), CURRENT_SQLITE_SCHEMA_VERSION);
    assert.equal(reports.length, 1);
    assert.match(reports[0], /copied to .*backup-schema-1-.*agent-local-a\.sqlite before pi-durable migrates it/);
    const copy = /copied to (.*) before/.exec(reports[0])?.[1] ?? "";
    assert.equal(versionOf(copy), 1);
  } finally {
    await stores.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});
