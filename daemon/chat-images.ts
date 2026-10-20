import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The pictures in the person's messages, as files a window can load (plan 029). A chat's store keeps each picture as
 * base64 inside the message the model got; a window gets only the message's text, so the daemon writes each picture
 * once to `<dir>/<name>` as it reads the message, and the thread carries the name. The name is the content (the first
 * 32 hex digits of its SHA-256, and its type's extension), so writing it again changes nothing, any Mac holding it
 * serves the same picture (mod/chat-images.ts), and the folder can be rebuilt from the stores at any time.
 */

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
};

/** What a picture's name looks like: nothing else is ever read or written under the folder. */
export const IMAGE_NAME = /^[0-9a-f]{32}\.(png|jpg|gif|webp|heic)$/;

/** The folder of pictures, written as messages are read. */
export class ChatImages {
  private readonly dir: string;
  /** Names written or found this run, so a page of history does not touch the disk again for each. */
  private readonly known = new Set<string>();

  constructor(dir: string) {
    this.dir = dir;
  }

  /** A picture's name, the file written first when it is not there; null for a type no window draws. */
  name(image: { data: string; mimeType: string }): string | null {
    const ext = EXTENSIONS[image.mimeType];
    if (!ext) return null;
    const name = `${createHash("sha256").update(image.data).digest("hex").slice(0, 32)}.${ext}`;
    if (this.known.has(name)) return name;
    const file = join(this.dir, name);
    try {
      if (!existsSync(file)) {
        mkdirSync(this.dir, { recursive: true });
        // Written beside it, then renamed: a window asking meanwhile finds the whole file or none.
        writeFileSync(`${file}.tmp`, Buffer.from(image.data, "base64"));
        renameSync(`${file}.tmp`, file);
      }
    } catch {
      return null;
    }
    this.known.add(name);
    return name;
  }
}
