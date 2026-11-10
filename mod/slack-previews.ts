import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SlackFile } from "../core/frame-types.ts";
import { messageOf } from "../core/errors.ts";
import { writeFileAtomic } from "./json-file.ts";
import { log } from "./log.ts";
import type { SlackThumb } from "./slack-markup.ts";

/**
 * The thumbnails of pictures shared in Slack (plan 080), saved where a message's pictures are (daemon/chat-images.ts,
 * plan 029) so every window and paired Mac loads them the same way. Slack serves a thumbnail only to a signed-in
 * session, so the account's Mac fetches it once, as the person, and the card names the file.
 *
 * A thumbnail's name comes from its account and Slack's address for it rather than its bytes, so a card read again finds
 * it without asking Slack. Slack never changes a file's thumbnail at an address, so the name still stands for one
 * picture, as the folder's names do.
 */

/** The extensions a thumbnail's address may end in, as the folder names them. */
const EXTENSIONS: Record<string, string> = { png: "png", jpg: "jpg", jpeg: "jpg", gif: "gif", webp: "webp" };

/** Fetches a thumbnail as the person on the account's workspace; null when Slack gave no picture. */
export type FetchThumb = (accountId: string, url: string) => Promise<{ data: Buffer } | null>;

/** The thumbnails folder, filled as cards are read. */
export class SlackPreviews {
  private readonly dir: string;
  private readonly fetchThumb: FetchThumb;
  /** Names saved or found this run, so a card read again does not touch the disk for each. */
  private readonly known = new Set<string>();
  /** Thumbnails being fetched, so two cards read at once ask Slack once. */
  private readonly pending = new Map<string, Promise<string | null>>();

  constructor(opts: { dir: string; fetchThumb: FetchThumb }) {
    this.dir = opts.dir;
    this.fetchThumb = opts.fetchThumb;
  }

  /** The preview a card draws for a thumbnail, fetched first when it is not saved; null when it cannot be had. */
  async preview(accountId: string, thumb: SlackThumb): Promise<SlackFile["preview"] | null> {
    const ext = EXTENSIONS[/\.([a-z]+)$/i.exec(new URL(thumb.url).pathname)?.[1]?.toLowerCase() ?? ""];
    if (!ext) return null;
    const name = `${createHash("sha256").update(`slack:${accountId}:${thumb.url}`).digest("hex").slice(0, 32)}.${ext}`;
    const saved = await this.save(accountId, thumb.url, name);
    return saved ? { name: saved, width: thumb.width, height: thumb.height } : null;
  }

  private save(accountId: string, url: string, name: string): Promise<string | null> {
    if (this.known.has(name)) return Promise.resolve(name);
    const file = join(this.dir, name);
    if (existsSync(file)) {
      this.known.add(name);
      return Promise.resolve(name);
    }
    const had = this.pending.get(name);
    if (had) return had;
    const p = this.fetchThumb(accountId, url)
      .then((got) => {
        if (!got) return null;
        // Written beside it, then renamed: a window asking meanwhile finds the whole file or none.
        writeFileAtomic(file, got.data);
        this.known.add(name);
        return name;
      })
      .catch((err: unknown) => {
        log("slack:preview-failed", { error: messageOf(err) });
        return null;
      })
      .finally(() => this.pending.delete(name));
    this.pending.set(name, p);
    return p;
  }
}
