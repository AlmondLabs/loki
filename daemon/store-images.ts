import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SHRINK_ABOVE_BYTES, shrinkImage, type Run } from "./image-shrink.ts";

/**
 * The pictures already in a chat's store, made the size `view_image` makes new ones (plan 032). Plan 029 shrinks a
 * picture before the model gets it; the ones read before that are in the store whole, base64 inside the tool result's
 * entry, and a store grew hundreds of MB on them. Only tool results are touched: a picture the person pasted is small
 * already, and the window's copy of it is named by its bytes (daemon/chat-images.ts). The daemon must not have the
 * store open: scripts/shrink-images.ts holds the daemon's lock while this runs.
 */

/** What one store held, and what it holds after (or would, without `apply`): sizes of the pictures' base64. */
export interface StoreImagesReport {
  file: string;
  /** Pictures that came out smaller. */
  pictures: number;
  before: number;
  after: number;
  /** The whole store as it was, copied before the change; null when nothing was written. */
  backup: string | null;
}

/** A picture part of a message, as pi-ai keeps it. */
interface ImagePart {
  type: "image";
  data: string;
  mimeType: string;
}

const isImage = (v: unknown): v is ImagePart =>
  typeof v === "object" && v !== null && (v as { type?: unknown }).type === "image" && typeof (v as { data?: unknown }).data === "string";

/** Every picture part anywhere in a record. */
function imagesIn(v: unknown, out: ImagePart[] = []): ImagePart[] {
  if (isImage(v)) out.push(v);
  else if (Array.isArray(v)) for (const x of v) imagesIn(x, out);
  else if (typeof v === "object" && v !== null) for (const x of Object.values(v)) imagesIn(x, out);
  return out;
}

/**
 * Shrink the large tool-result pictures in the store at `file`. Without `apply` the store is only read and the report
 * says what would change. With it, the store is first copied whole into `backupDir`, then the entries are rewritten in
 * one transaction and the file compacted. `run` and `platform` reach the shrink (tests inject them).
 */
export async function shrinkStoreImages(
  file: string,
  opts: { apply: boolean; backupDir: string; run?: Run; platform?: NodeJS.Platform },
): Promise<StoreImagesReport> {
  const db = new DatabaseSync(file, { readOnly: !opts.apply });
  const work = mkdtempSync(join(tmpdir(), "loki-store-images-"));
  const report: StoreImagesReport = { file, pictures: 0, before: 0, after: 0, backup: null };
  const changed: Array<{ id: number; record: string }> = [];
  try {
    const rows = db
      .prepare(`SELECT id, record FROM entries WHERE record LIKE '%"type":"image"%' AND json_extract(record, '$.kind') = 'pi.tool-result'`)
      .all() as Array<{ id: number; record: string }>;
    for (const row of rows) {
      const record: unknown = JSON.parse(row.record);
      let touched = false;
      for (const image of imagesIn(record)) {
        // Base64 is four characters to three bytes: no need to decode one that is small.
        if (image.data.length * 0.75 <= SHRINK_ABOVE_BYTES || image.mimeType === "image/gif") continue;
        const source = join(work, "picture");
        writeFileSync(source, Buffer.from(image.data, "base64"));
        const shrunk = await shrinkImage(source, image.mimeType, { run: opts.run, platform: opts.platform });
        const data = shrunk.data.toString("base64");
        if (data.length >= image.data.length) continue;
        report.pictures += 1;
        report.before += image.data.length;
        report.after += data.length;
        image.data = data;
        image.mimeType = shrunk.mimeType;
        touched = true;
      }
      if (touched) changed.push({ id: row.id, record: JSON.stringify(record) });
    }
    if (!opts.apply || changed.length === 0) return report;

    mkdirSync(opts.backupDir, { recursive: true });
    const backup = join(opts.backupDir, basename(file));
    // VACUUM INTO writes one consistent file, with whatever the write-ahead log still holds.
    db.prepare("VACUUM INTO ?").run(backup);
    report.backup = backup;
    const update = db.prepare("UPDATE entries SET record = ? WHERE id = ?");
    db.exec("BEGIN");
    try {
      for (const c of changed) update.run(c.record, c.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    db.exec("VACUUM");
    // The write-ahead log keeps what VACUUM rewrote until a checkpoint: fold it in, so the space comes back now.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return report;
  } finally {
    db.close();
    rmSync(work, { recursive: true, force: true });
  }
}
