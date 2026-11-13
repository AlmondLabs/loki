import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ImageProcessor } from "@earendil-works/pi-durable/tools";

/**
 * An image a tool hands the model, made the size the person's own pasted images are (plan 029; the app's
 * app/src/chat/attachments.ts): at most SHRINK_LONG_EDGE pixels on its long edge, as JPEG. Each image in a tool
 * result is kept in the chat's store for good, so a 500 KB screenshot read once costs 500 KB forever. macOS's `sips`
 * does the work; elsewhere (no `sips`), for a GIF, a small file or a resize that fails or saves nothing, the file goes
 * as it is.
 */

/** Files at or under this size go as they are: shrinking them saves too little to be worth a process. */
export const SHRINK_ABOVE_BYTES = 300 * 1024;
/** The long edge an image is brought down to, as the app does for one pasted into a message. */
export const SHRINK_LONG_EDGE = 1600;
/** The JPEG quality it is written at (the app's 0.85). */
export const SHRINK_QUALITY = 85;

/** Runs a program and gives its standard output; throws when it fails. */
export type Run = (file: string, args: string[]) => Promise<string>;

const realRun: Run = async (file, args) => (await promisify(execFile)(file, args, { timeout: 20_000 })).stdout;

/** The image at `file` as the model should get it: its bytes and type, shrunk when that is worth it and possible. */
export async function shrinkImage(
  file: string,
  mimeType: string,
  opts: { run?: Run; platform?: NodeJS.Platform } = {},
): Promise<{ data: Buffer; mimeType: string }> {
  return shrunk(await readFile(file), mimeType, file, opts);
}

/** The image types a model takes as they are; any other (a BMP, which `read` accepts) must become JPEG first. */
const MODEL_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * The image `read` hands the model, shrunk (plan 094): pi-durable's `read` prepares every image through this, so a
 * picture read once is kept at the size `image_view` once made it. An image still past `read`'s byte limit after that,
 * or one that could not become a type the model takes, is refused, as `read` refuses one with no processor.
 */
export function shrinkingProcessor(opts: { run?: Run; platform?: NodeJS.Platform } = {}): ImageProcessor {
  return {
    async prepare(bytes, mimeType, limits) {
      const data = Buffer.from(bytes);
      const image = await shrunk(data, mimeType, null, { ...opts, always: !MODEL_TYPES.has(mimeType) });
      const base64 = image.data.toString("base64");
      return MODEL_TYPES.has(image.mimeType) && base64.length <= limits.maxBytes ? { data: base64, mimeType: image.mimeType } : undefined;
    },
  };
}

/**
 * `data` shrunk; `file` is where it already is on disk, or null to write it out for `sips` first. `always` converts it
 * whatever its size, for a type the model does not take.
 */
async function shrunk(
  data: Buffer,
  mimeType: string,
  file: string | null,
  opts: { run?: Run; platform?: NodeJS.Platform; always?: boolean },
): Promise<{ data: Buffer; mimeType: string }> {
  const original = { data, mimeType };
  if ((!opts.always && data.length <= SHRINK_ABOVE_BYTES) || mimeType === "image/gif" || (opts.platform ?? process.platform) !== "darwin") return original;
  const run = opts.run ?? realRun;
  const dir = await mkdtemp(join(tmpdir(), "loki-shrink-"));
  try {
    const source = file ?? join(dir, "source");
    if (!file) await writeFile(source, data);
    // Its size first: `sips -Z` would also enlarge a smaller one.
    const dims = await run("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", source]);
    const sides = [...dims.matchAll(/pixel(?:Width|Height):\s*(\d+)/g)].map((m) => Number(m[1]));
    const long = sides.length ? Math.max(...sides) : 0;
    const out = join(dir, "shrunk.jpg");
    const resize = long > SHRINK_LONG_EDGE ? ["-Z", String(SHRINK_LONG_EDGE)] : [];
    await run("/usr/bin/sips", [...resize, "-s", "format", "jpeg", "-s", "formatOptions", String(SHRINK_QUALITY), source, "--out", out]);
    const made = await readFile(out);
    return made.length > 0 && (opts.always || made.length < data.length) ? { data: made, mimeType: "image/jpeg" } : original;
  } catch {
    return original;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
