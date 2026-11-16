import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function copyStore(db: DatabaseSync, file: string, dir: string): string {
  const copy = join(dir, basename(file));
  if (existsSync(copy)) return copy;
  mkdirSync(dir, { recursive: true });
  db.prepare("VACUUM INTO ?").run(copy);
  return copy;
}

export function backupBeforeMigration(file: string, current: number, now = new Date()): string | null {
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'durable_schema'").get();
    if (!table) return null;
    const row = db.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get() as { version: number } | undefined;
    const version = row?.version ?? 0;
    if (version >= current) return null;
    return copyStore(db, file, join(dirname(file), `backup-schema-${version}-${now.toISOString().slice(0, 10)}`));
  } finally {
    db.close();
  }
}
