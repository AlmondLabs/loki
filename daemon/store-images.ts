import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SHRINK_ABOVE_BYTES, shrinkImage, type Run } from "./image-shrink.ts";
import { copyStore } from "./store-backup.ts";

export interface StoreImagesReport {
  file: string;
  pictures: number;
  before: number;
  after: number;
  backup: string | null;
}

interface ImagePart {
  type: "image";
  data: string;
  mimeType: string;
}

const isImage = (v: unknown): v is ImagePart =>
  typeof v === "object" && v !== null && (v as { type?: unknown }).type === "image" && typeof (v as { data?: unknown }).data === "string";

function imagesIn(v: unknown, out: ImagePart[] = []): ImagePart[] {
  if (isImage(v)) out.push(v);
  else if (Array.isArray(v)) for (const x of v) imagesIn(x, out);
  else if (typeof v === "object" && v !== null) for (const x of Object.values(v)) imagesIn(x, out);
  return out;
}

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

    report.backup = copyStore(db, file, opts.backupDir);
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
