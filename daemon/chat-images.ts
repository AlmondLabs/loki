import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../mod/json-file.ts";

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
};

export const IMAGE_NAME = /^[0-9a-f]{32}\.(png|jpg|gif|webp|heic)$/;

export class ChatImages {
  private readonly dir: string;
  private readonly known = new Set<string>();

  constructor(dir: string) {
    this.dir = dir;
  }

  name(image: { data: string; mimeType: string }): string | null {
    const ext = EXTENSIONS[image.mimeType];
    if (!ext) return null;
    const name = `${createHash("sha256").update(image.data).digest("hex").slice(0, 32)}.${ext}`;
    if (this.known.has(name)) return name;
    const file = join(this.dir, name);
    try {
      if (!existsSync(file)) {
        writeFileAtomic(file, Buffer.from(image.data, "base64"));
      }
    } catch {
      return null;
    }
    this.known.add(name);
    return name;
  }
}
