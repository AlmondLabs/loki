import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SlackFile } from "../core/frame-types.ts";
import { messageOf } from "../core/errors.ts";
import { writeFileAtomic } from "./json-file.ts";
import { log } from "./log.ts";
import type { SlackThumb } from "./slack-markup.ts";

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/pjpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
};

const extensionOf = (type: string): string | undefined => EXTENSIONS[type.split(";")[0].trim().toLowerCase()];

const MISS_MS = 30 * 60_000;

export type FetchPreview = () => Promise<{ data: Buffer; type: string } | null>;

export class OutsidePreviews {
  private readonly dir: string;
  private readonly known = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string | null>>();
  private readonly missed = new Map<string, number>();
  private readonly now: () => number;

  constructor(opts: { dir: string; now?: () => number }) {
    this.dir = opts.dir;
    this.now = opts.now ?? Date.now;
  }

  preview(key: string, fetch: FetchPreview): Promise<string | null> {
    const had = this.known.get(key) ?? this.pending.get(key);
    if (had !== undefined) return typeof had === "string" ? Promise.resolve(had) : had;
    const stem = createHash("sha256").update(key).digest("hex").slice(0, 32);
    const saved = [...new Set(Object.values(EXTENSIONS))].map((ext) => `${stem}.${ext}`).find((name) => existsSync(join(this.dir, name)));
    if (saved) {
      this.known.set(key, saved);
      return Promise.resolve(saved);
    }
    const missedAt = this.missed.get(key);
    if (missedAt !== undefined && this.now() - missedAt < MISS_MS) return Promise.resolve(null);
    const p = fetch()
      .then((got) => {
        const ext = got && extensionOf(got.type);
        if (!got || !ext) {
          this.missed.set(key, this.now());
          return null;
        }
        const name = `${stem}.${ext}`;
        writeFileAtomic(join(this.dir, name), got.data);
        this.known.set(key, name);
        return name;
      })
      .catch((err: unknown) => {
        log("outside:preview-failed", { error: messageOf(err) });
        this.missed.set(key, this.now());
        return null;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }
}

const SLACK_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

export type FetchThumb = (accountId: string, url: string) => Promise<{ data: Buffer; type: string } | null>;

export function slackPreviews(store: OutsidePreviews, fetchThumb: FetchThumb): (accountId: string, thumb: SlackThumb) => Promise<SlackFile["preview"] | null> {
  return async (accountId, thumb) => {
    const ext = /\.([a-z]+)$/i.exec(new URL(thumb.url).pathname)?.[1]?.toLowerCase() ?? "";
    if (!SLACK_EXTENSIONS.has(ext)) return null;
    const name = await store.preview(`slack:${accountId}:${thumb.url}`, () => fetchThumb(accountId, thumb.url));
    return name ? { name, width: thumb.width, height: thumb.height } : null;
  };
}
