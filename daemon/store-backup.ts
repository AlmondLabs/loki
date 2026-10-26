import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Whole copies of a chat store (`<loki>/stores/<agent>.sqlite`), for the two things that change one in a way that
 * cannot be undone: `npm run shrink-images -- --apply` (plan 032), and pi-durable migrating its schema when a newer
 * version opens it (plan 039; 1.4.0 moves version 1 to 2, which older versions cannot open).
 */

/**
 * Copy the store `db` has open into `dir`, under its own name; the copy's path. `VACUUM INTO` writes one consistent file,
 * with whatever the write-ahead log still holds. A copy already there is kept: it was made from the store as it was then.
 */
export function copyStore(db: DatabaseSync, file: string, dir: string): string {
  const copy = join(dir, basename(file));
  if (existsSync(copy)) return copy;
  mkdirSync(dir, { recursive: true });
  db.prepare("VACUUM INTO ?").run(copy);
  return copy;
}

/**
 * Before pi-durable opens the store at `file`: when its schema is older than `current`, the version this pi-durable
 * migrates it to, copy it whole to `<stores>/backup-schema-<version>-<date>/`, the way back to an older loki. Null when
 * there is nothing to copy: no file yet, a store pi-durable never set up, or one already at `current`.
 */
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
