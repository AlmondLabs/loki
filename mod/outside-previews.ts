import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SlackFile } from "../core/frame-types.ts";
import { messageOf } from "../core/errors.ts";
import { writeFileAtomic } from "./json-file.ts";
import { log } from "./log.ts";
import type { SlackThumb } from "./slack-markup.ts";

/**
 * The thumbnails of pictures shared in Slack (plan 080) and in Jira comments (plan 092), saved where a message's
 * pictures are (daemon/chat-images.ts, plan 029) so every window and paired Mac loads them the same way. Each service
 * serves a thumbnail only to a signed-in session, so the account's Mac fetches it once, as the person, and the card
 * names the file.
 *
 * A thumbnail's name comes from a key naming its service, account and picture rather than from its bytes, so a card read
 * again finds it without asking the service. Neither service changes the thumbnail behind a key, so the name still
 * stands for one picture, as the folder's names do. The extension comes from the type the service answered with, so a
 * saved file is found by trying each extension the folder serves.
 */

/** The picture types the folder serves, and the extension each is saved under (as daemon/chat-images.ts names them). */
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  // Spellings some servers send for a JPEG; the old store named Slack's by address and never saw the type.
  "image/jpg": "jpg",
  "image/pjpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
};

/** The extension a content type is saved under, read without regard to case or parameters; undefined for any other. */
const extensionOf = (type: string): string | undefined => EXTENSIONS[type.split(";")[0].trim().toLowerCase()];

/**
 * How long a thumbnail that could not be had is not asked again: long enough that reading a card again does not wait on
 * the same refusal, short enough that one made later (a picture still being processed) shows the same day.
 */
const MISS_MS = 30 * 60_000;

/** A thumbnail's bytes and their content type, as its service answered; null when it gave no picture. */
export type FetchPreview = () => Promise<{ data: Buffer; type: string } | null>;

/** The thumbnails folder, filled as cards are read. */
export class OutsidePreviews {
  private readonly dir: string;
  /** The name saved or found this run for each key, so a card read again does not touch the disk for each. */
  private readonly known = new Map<string, string>();
  /** Thumbnails being fetched, by key, so two cards read at once ask once. */
  private readonly pending = new Map<string, Promise<string | null>>();
  /** When each key last gave no thumbnail, so a card read again within MISS_MS does not ask or wait again. */
  private readonly missed = new Map<string, number>();
  private readonly now: () => number;

  constructor(opts: { dir: string; now?: () => number }) {
    this.dir = opts.dir;
    this.now = opts.now ?? Date.now;
  }

  /**
   * The saved name of the thumbnail a key names (a service, an account and a picture, as `jira:<account>:<id>`),
   * fetched with `fetch` first when it is not saved; null when it cannot be had or its type is not one the folder serves.
   */
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
        // Written beside it, then renamed: a window asking meanwhile finds the whole file or none.
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

/** The extensions a Slack thumbnail's address may end in: one ending otherwise names no picture and is not fetched. */
const SLACK_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

/** Fetches a Slack thumbnail as the person on the account's workspace; null when Slack gave no picture. */
export type FetchThumb = (accountId: string, url: string) => Promise<{ data: Buffer; type: string } | null>;

/**
 * The preview a Slack card draws for a thumbnail, through the store. The key is `slack:<account>:<address>`, the one
 * plan 080 named files by, so thumbnails saved before Jira shared the store are still found without a fetch.
 */
export function slackPreviews(store: OutsidePreviews, fetchThumb: FetchThumb): (accountId: string, thumb: SlackThumb) => Promise<SlackFile["preview"] | null> {
  return async (accountId, thumb) => {
    const ext = /\.([a-z]+)$/i.exec(new URL(thumb.url).pathname)?.[1]?.toLowerCase() ?? "";
    if (!SLACK_EXTENSIONS.has(ext)) return null;
    const name = await store.preview(`slack:${accountId}:${thumb.url}`, () => fetchThumb(accountId, thumb.url));
    return name ? { name, width: thumb.width, height: thumb.height } : null;
  };
}
