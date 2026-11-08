/**
 * Snappy decompression, for the blocks of the Slack desktop app's Local Storage (plan 067, U6). LevelDB compresses its
 * table blocks with Snappy; reading them needs only the decoder, which is small enough to keep here rather than add a
 * dependency. It follows Snappy's format description: a varint length, then literals and copies of earlier output.
 */

function varint(buf: Buffer, at: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = at;
  while (i < buf.length) {
    const b = buf[i] ?? 0;
    i++;
    value += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return { value, next: i };
    shift += 7;
    if (shift > 35) break;
  }
  throw new Error("snappy: bad length");
}

/** The bytes a Snappy-compressed buffer holds; throws on input that is cut short or points outside what it wrote. */
export function snappyUncompress(input: Buffer): Buffer {
  const { value: length, next } = varint(input, 0);
  const out = Buffer.alloc(length);
  let at = next;
  let written = 0;
  const byte = (i: number) => {
    if (i >= input.length) throw new Error("snappy: input cut short");
    return input[i];
  };
  while (at < input.length) {
    const tag = byte(at);
    at++;
    const kind = tag & 3;
    if (kind === 0) {
      let len = (tag >> 2) + 1;
      if (len > 60) {
        // 61 to 64: the length less one follows in 1 to 4 little-endian bytes.
        const bytes = len - 60;
        len = 0;
        for (let k = 0; k < bytes; k++) len += byte(at + k) * 2 ** (8 * k);
        len += 1;
        at += bytes;
      }
      if (at + len > input.length || written + len > length) throw new Error("snappy: literal runs past the end");
      input.copy(out, written, at, at + len);
      at += len;
      written += len;
      continue;
    }
    let len: number;
    let offset: number;
    if (kind === 1) {
      len = ((tag >> 2) & 7) + 4;
      offset = ((tag >> 5) << 8) | byte(at);
      at += 1;
    } else if (kind === 2) {
      len = (tag >> 2) + 1;
      offset = byte(at) | (byte(at + 1) << 8);
      at += 2;
    } else {
      len = (tag >> 2) + 1;
      offset = (byte(at) | (byte(at + 1) << 8) | (byte(at + 2) << 16)) + byte(at + 3) * 2 ** 24;
      at += 4;
    }
    if (offset === 0 || offset > written || written + len > length) throw new Error("snappy: copy points outside the output");
    // Byte by byte: a copy may overlap what it is writing, which repeats a run.
    for (let k = 0; k < len; k++) out[written + k] = out[written + k - offset] ?? 0;
    written += len;
  }
  if (written !== length) throw new Error("snappy: output shorter than its length");
  return out;
}
