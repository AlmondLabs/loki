import { describe, expect, test } from "vitest";
import { snappyUncompress } from "../mod/slack-snappy.ts";

// Hand-built Snappy blocks, byte by byte from the format description, so each branch of the decoder is reached by
// bytes a real LevelDB table can hold rather than by what the fixtures' own encoder happens to write.

/** A literal tag for 1 to 60 bytes: its length less one in the upper six bits. */
const literal = (text: string) => [(text.length - 1) << 2, ...Buffer.from(text, "latin1")];

describe("Snappy blocks from the Slack app's Local Storage (plan 067, U6)", () => {
  test("a copy with a one-byte offset (kind 1) repeats earlier output", () => {
    // Length 8: tag (8 - 4) << 2 | 1, offset 4 in the byte after.
    const block = Buffer.from([12, ...literal("abcd"), (4 << 2) | 1, 4]);
    expect(snappyUncompress(block).toString("latin1")).toBe("abcdabcdabcd");
  });

  test("a kind-1 copy whose offset carries three high bits in its tag reaches past 255 bytes", () => {
    // 300 bytes of literal (tag 61 << 2: two length bytes follow, 299 little-endian), then a copy of 4 from offset 260
    // (high bits 1 in the tag, low byte 4).
    const text = Array.from({ length: 300 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
    const block = Buffer.from([0xb0, 0x02, 61 << 2, 299 & 0xff, 299 >> 8, ...Buffer.from(text, "latin1"), (1 << 5) | 1, 4]);
    expect(snappyUncompress(block).toString("latin1")).toBe(text + text.slice(40, 44));
  });

  test("a copy with a four-byte offset (kind 3) repeats earlier output", () => {
    // Length 3: tag (3 - 1) << 2 | 3, offset 5 as four little-endian bytes.
    const block = Buffer.from([8, ...literal("hello"), (2 << 2) | 3, 5, 0, 0, 0]);
    expect(snappyUncompress(block).toString("latin1")).toBe("hellohel");
  });

  test("a literal of more than 60 bytes takes its length from the byte after the tag", () => {
    const text = "x".repeat(70) + "yz";
    // Tag 60 << 2: one length byte follows, holding the length less one.
    const block = Buffer.from([72, 60 << 2, 71, ...Buffer.from(text, "latin1")]);
    expect(snappyUncompress(block).toString("latin1")).toBe(text);
  });

  test("a copy that overlaps what it writes (offset 1) repeats one byte as a run", () => {
    // Length 6: tag (6 - 1) << 2 | 2, offset 1 as two little-endian bytes.
    const block = Buffer.from([7, ...literal("a"), (5 << 2) | 2, 1, 0]);
    expect(snappyUncompress(block).toString("latin1")).toBe("aaaaaaa");
  });

  test("input cut short is refused, in a literal and in a copy's offset", () => {
    expect(() => snappyUncompress(Buffer.from([5, (4 << 2) | 0, 0x61, 0x62]))).toThrow("snappy: literal runs past the end");
    expect(() => snappyUncompress(Buffer.from([6, ...literal("ab"), (3 << 2) | 2, 1]))).toThrow("snappy: input cut short");
  });

  test("a copy from offset 0, or from before the start, is refused", () => {
    expect(() => snappyUncompress(Buffer.from([6, ...literal("ab"), (3 << 2) | 2, 0, 0]))).toThrow("snappy: copy points outside the output");
    expect(() => snappyUncompress(Buffer.from([6, ...literal("ab"), (3 << 2) | 2, 3, 0]))).toThrow("snappy: copy points outside the output");
  });

  test("output shorter than the length it starts with is refused", () => {
    expect(() => snappyUncompress(Buffer.from([10, ...literal("abcd")]))).toThrow("snappy: output shorter than its length");
  });
});
