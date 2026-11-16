import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ImageProcessor } from "@earendil-works/pi-durable/tools";

export const SHRINK_ABOVE_BYTES = 300 * 1024;
export const SHRINK_LONG_EDGE = 1600;
export const SHRINK_QUALITY = 85;

export type Run = (file: string, args: string[]) => Promise<string>;

const realRun: Run = async (file, args) => (await promisify(execFile)(file, args, { timeout: 20_000 })).stdout;

export async function shrinkImage(
  file: string,
  mimeType: string,
  opts: { run?: Run; platform?: NodeJS.Platform } = {},
): Promise<{ data: Buffer; mimeType: string }> {
  return shrunk(await readFile(file), mimeType, file, opts);
}

/** The image types a model takes as they are; any other (a BMP, which `read` accepts) must become JPEG first. */
const MODEL_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

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
