/**
 * Plan 032: the pictures already in a chat's store, shrunk as view_image shrinks new ones. Runs under Node (the store is
 * `node:sqlite`): npm run test:node
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Run } from "../daemon/image-shrink.ts";
import { shrinkStoreImages } from "../daemon/store-images.ts";

const big = Buffer.alloc(400 * 1024, 7).toString("base64");
const small = Buffer.alloc(10 * 1024, 7).toString("base64");
const shrunkBytes = Buffer.from("tiny jpeg");

/** sips as the shrink calls it: the size asked first, then the JPEG written where `--out` says. */
const sips: Run = (_file, args) => {
  if (args[0] === "-g") return Promise.resolve("pixelWidth: 3000\npixelHeight: 2000\n");
  writeFileSync(args[args.length - 1], shrunkBytes);
  return Promise.resolve("");
};

const toolResult = (images: Array<{ data: string; mimeType: string }>) =>
  JSON.stringify({
    kind: "pi.tool-result",
    model: [{ role: "toolResult", toolName: "view_image", content: [{ type: "text", text: "[Image]" }, ...images.map((i) => ({ type: "image", ...i }))] }],
  });
const pasted = JSON.stringify({ kind: "pi.user", model: [{ role: "user", content: [{ type: "image", data: big, mimeType: "image/png" }] }] });

/** A store with the one table the shrink reads: a large picture, a small one, a GIF, and a pasted one. */
function store(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "loki-shrink-test-"));
  const file = join(dir, "agent.sqlite");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, record TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO entries (id, record) VALUES (?, ?)");
  insert.run(1, toolResult([{ data: big, mimeType: "image/png" }]));
  insert.run(2, toolResult([{ data: small, mimeType: "image/png" }]));
  insert.run(3, toolResult([{ data: big, mimeType: "image/gif" }]));
  insert.run(4, pasted);
  db.close();
  return { dir, file };
}

const records = (file: string): string[] => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("SELECT record FROM entries ORDER BY id").all() as Array<{ record: string }>).map((r) => r.record);
  } finally {
    db.close();
  }
};

void test("the report counts only a large tool-result picture, and without apply the store is not changed", async () => {
  const { dir, file } = store();
  try {
    const before = records(file);
    const report = await shrinkStoreImages(file, { apply: false, backupDir: join(dir, "backup"), run: sips, platform: "darwin" });
    assert.equal(report.pictures, 1);
    assert.equal(report.before, big.length);
    assert.equal(report.after, shrunkBytes.toString("base64").length);
    assert.equal(report.backup, null);
    assert.deepEqual(records(file), before);
    assert.equal(existsSync(join(dir, "backup")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("apply copies the store first, then shrinks the large picture and leaves the rest byte for byte", async () => {
  const { dir, file } = store();
  try {
    const before = records(file);
    const report = await shrinkStoreImages(file, { apply: true, backupDir: join(dir, "backup"), run: sips, platform: "darwin" });
    assert.equal(report.backup, join(dir, "backup", "agent.sqlite"));
    assert.deepEqual(records(report.backup), before);
    const after = records(file);
    const image = (JSON.parse(after[0]) as { model: Array<{ content: Array<{ type: string; data?: string; mimeType?: string }> }> }).model[0].content[1];
    assert.equal(image.data, shrunkBytes.toString("base64"));
    assert.equal(image.mimeType, "image/jpeg");
    assert.deepEqual(after.slice(1), before.slice(1));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("off macOS, or when the shrink fails, nothing changes", async () => {
  const { dir, file } = store();
  try {
    const before = records(file);
    const elsewhere = await shrinkStoreImages(file, { apply: true, backupDir: join(dir, "backup"), run: sips, platform: "linux" });
    assert.equal(elsewhere.pictures, 0);
    const failing: Run = () => Promise.reject(new Error("sips failed"));
    const failed = await shrinkStoreImages(file, { apply: true, backupDir: join(dir, "backup"), run: failing, platform: "darwin" });
    assert.equal(failed.pictures, 0);
    assert.deepEqual(records(file), before);
    assert.equal(existsSync(join(dir, "backup")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("while loki holds the lock the command stops, reading and writing nothing", () => {
  const { dir, file } = store();
  try {
    mkdirSync(join(dir, "stores"));
    writeFileSync(join(dir, "stores", "agent.sqlite"), "");
    writeFileSync(join(dir, "daemon.lock"), String(process.pid));
    const script = join(import.meta.dirname, "..", "scripts", "shrink-images.ts");
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script, "--apply", "--dir", dir], { encoding: "utf8" });
    if (process.platform !== "darwin") {
      assert.equal(r.status, 0);
      return;
    }
    assert.equal(r.status, 1);
    assert.match(r.stderr, /loki is running/);
    assert.equal(existsSync(join(dir, "stores", `backup-${new Date().toISOString().slice(0, 10)}`)), false);
    assert.ok(existsSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
