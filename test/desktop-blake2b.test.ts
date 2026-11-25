import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { blake2b512, createBlake2b512 } from "../desktop/update/blake2b.ts";

const nodes = (data: Uint8Array) => createHash("blake2b512").update(data).digest("hex");
const ours = (data: Uint8Array) => Buffer.from(blake2b512(data)).toString("hex");
const bytes = (length: number) => Uint8Array.from({ length }, (_, i) => (i * 131 + 7) & 0xff);

describe("BLAKE2b-512 in TypeScript", () => {
  test("the empty input is RFC 7693's known digest", () => {
    expect(ours(new Uint8Array())).toBe(
      "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce",
    );
  });

  test('"abc" is RFC 7693\'s appendix A digest', () => {
    expect(ours(new TextEncoder().encode("abc"))).toBe(
      "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
    );
  });

  test.each([0, 1, 3, 127, 128, 129, 255, 256, 257, 1000, 1024 * 1024])("%i bytes hash as Node's blake2b512 does", (length) => {
    const data = bytes(length);
    expect(ours(data)).toBe(nodes(data));
  });

  test("a view into a larger buffer hashes only its own bytes", () => {
    const whole = bytes(300);
    const view = whole.subarray(17, 200);
    expect(ours(view)).toBe(nodes(Buffer.from(view)));
  });
});

describe("BLAKE2b-512 fed in pieces, as a download arrives", () => {
  test.each([
    [1000, [1, 127, 128, 129, 615]],
    [1024, [128, 128, 768]],
    [256, [256, 0]],
    [130, [0, 64, 64, 2]],
    [70_000, [65_536, 4464]],
  ])("%i bytes in pieces of %j hash as the whole does", (length, pieces) => {
    const data = bytes(length);
    const hash = createBlake2b512();
    let at = 0;
    for (const piece of pieces) {
      hash.update(data.subarray(at, at + piece));
      at += piece;
    }
    expect(Buffer.from(hash.digest()).toString("hex")).toBe(nodes(data));
  });
});
