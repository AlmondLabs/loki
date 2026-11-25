// Outside (Electron): its Node is built on BoringSSL, which has no blake2b512 digest, and minisign's prehashed
// signatures sign the BLAKE2b-512 of the file. This is RFC 7693's BLAKE2b, unkeyed, with a 64-byte digest:
// https://www.rfc-editor.org/rfc/rfc7693

const BLOCK_BYTES = 128;
const DIGEST_BYTES = 64;
const ROUNDS = 12;

const IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a, 0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b,
  0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

const SIGMA_WORDS = Uint8Array.from(Array.from({ length: ROUNDS }, (_, round) => SIGMA[round % SIGMA.length].map((i) => i * 2)).flat());

function addWords(v: Uint32Array, a: number, b: number): void {
  const low = v[a] + v[b];
  v[a] = low;
  v[a + 1] = v[a + 1] + v[b + 1] + (low >= 0x100000000 ? 1 : 0);
}

function addMessage(v: Uint32Array, a: number, low: number, high: number): void {
  const sum = v[a] + low;
  v[a] = sum;
  v[a + 1] = v[a + 1] + high + (sum >= 0x100000000 ? 1 : 0);
}

function mix(v: Uint32Array, m: Uint32Array, a: number, b: number, c: number, d: number, x: number, y: number): void {
  addWords(v, a, b);
  addMessage(v, a, m[x], m[x + 1]);
  let low = v[d] ^ v[a];
  let high = v[d + 1] ^ v[a + 1];
  v[d] = high;
  v[d + 1] = low;
  addWords(v, c, d);
  low = v[b] ^ v[c];
  high = v[b + 1] ^ v[c + 1];
  v[b] = (low >>> 24) ^ (high << 8);
  v[b + 1] = (high >>> 24) ^ (low << 8);
  addWords(v, a, b);
  addMessage(v, a, m[y], m[y + 1]);
  low = v[d] ^ v[a];
  high = v[d + 1] ^ v[a + 1];
  v[d] = (low >>> 16) ^ (high << 16);
  v[d + 1] = (high >>> 16) ^ (low << 16);
  addWords(v, c, d);
  low = v[b] ^ v[c];
  high = v[b + 1] ^ v[c + 1];
  v[b] = (high >>> 31) ^ (low << 1);
  v[b + 1] = (low >>> 31) ^ (high << 1);
}

interface Hashing {
  h: Uint32Array;
  v: Uint32Array;
  m: Uint32Array;
}

function compress({ h, v, m }: Hashing, block: Uint8Array, at: number, counted: number, last: boolean): void {
  v.set(h);
  v.set(IV, 16);
  v[24] ^= counted >>> 0;
  v[25] ^= Math.floor(counted / 0x100000000);
  if (last) {
    v[28] = ~v[28];
    v[29] = ~v[29];
  }
  for (let i = 0; i < 32; i++) {
    const j = at + i * 4;
    m[i] = block[j] | (block[j + 1] << 8) | (block[j + 2] << 16) | (block[j + 3] << 24);
  }
  for (let r = 0; r < ROUNDS * 16; r += 16) {
    const s = SIGMA_WORDS;
    mix(v, m, 0, 8, 16, 24, s[r], s[r + 1]);
    mix(v, m, 2, 10, 18, 26, s[r + 2], s[r + 3]);
    mix(v, m, 4, 12, 20, 28, s[r + 4], s[r + 5]);
    mix(v, m, 6, 14, 22, 30, s[r + 6], s[r + 7]);
    mix(v, m, 0, 10, 20, 30, s[r + 8], s[r + 9]);
    mix(v, m, 2, 12, 22, 24, s[r + 10], s[r + 11]);
    mix(v, m, 4, 14, 16, 26, s[r + 12], s[r + 13]);
    mix(v, m, 6, 8, 18, 28, s[r + 14], s[r + 15]);
  }
  for (let i = 0; i < 16; i++) h[i] ^= v[i] ^ v[i + 16];
}

export interface Blake2b {
  update: (data: Uint8Array) => void;
  digest: () => Uint8Array;
}

export function createBlake2b(digestBytes: number): Blake2b {
  if (!Number.isInteger(digestBytes) || digestBytes < 1 || digestBytes > DIGEST_BYTES)
    throw new Error(`BLAKE2b digests 1 to ${DIGEST_BYTES} bytes, not ${digestBytes}`);
  const hashing: Hashing = { h: IV.slice(), v: new Uint32Array(32), m: new Uint32Array(32) };
  hashing.h[0] ^= 0x01010000 ^ digestBytes;
  const pending = new Uint8Array(BLOCK_BYTES);
  let filled = 0;
  let counted = 0;
  const update = (data: Uint8Array) => {
    let at = 0;
    while (at < data.length) {
      if (filled === BLOCK_BYTES) {
        compress(hashing, pending, 0, counted, false);
        filled = 0;
      }
      for (; filled === 0 && data.length - at > BLOCK_BYTES; at += BLOCK_BYTES) {
        counted += BLOCK_BYTES;
        compress(hashing, data, at, counted, false);
      }
      const take = Math.min(BLOCK_BYTES - filled, data.length - at);
      pending.set(data.subarray(at, at + take), filled);
      filled += take;
      counted += take;
      at += take;
    }
  };
  const digest = () => {
    pending.fill(0, filled);
    compress(hashing, pending, 0, counted, true);
    const out = new Uint8Array(digestBytes);
    for (let i = 0; i < digestBytes; i++) out[i] = hashing.h[i >> 2] >>> (8 * (i & 3));
    return out;
  };
  return { update, digest };
}

export const createBlake2b512 = (): Blake2b => createBlake2b(DIGEST_BYTES);

export function blake2b(data: Uint8Array, digestBytes: number): Uint8Array {
  const hash = createBlake2b(digestBytes);
  hash.update(data);
  return hash.digest();
}

export const blake2b512 = (data: Uint8Array): Uint8Array => blake2b(data, DIGEST_BYTES);
