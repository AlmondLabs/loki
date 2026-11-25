import { createPrivateKey, createPublicKey, scryptSync, timingSafeEqual, type KeyObject } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { blake2b } from "../desktop/update/blake2b.ts";
import { parsePublicKey, signatureFile, UPDATE_PUBLIC_KEY } from "../desktop/update/minisign.ts";

const SIGNATURE_ALGORITHM = "Ed";
const SCRYPT = "Sc";
const UNENCRYPTED = "\0\0";
const CHECKSUM_ALGORITHM = "B2";
const SALT_BYTES = 32;
const KEY_ID_BYTES = 8;
const SECRET_BYTES = 64;
const CHECKSUM_BYTES = 32;
const ENCRYPTED_BYTES = KEY_ID_BYTES + SECRET_BYTES + CHECKSUM_BYTES;
const SECRET_KEY_BYTES = 2 + 2 + 2 + SALT_BYTES + 8 + 8 + ENCRYPTED_BYTES;
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface SecretKey {
  keyId: Uint8Array;
  privateKey: KeyObject;
}

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

// Outside (libsodium): minisign stores scrypt's cost as libsodium's opslimit and memlimit, and libsodium turns them into
// N, r and p with `pickparams` in crypto_pwhash/scryptsalsa208sha256/pwhash_scryptsalsa208sha256.c.
export function scryptParams(opslimit: number, memlimit: number): ScryptParams {
  const ops = Math.max(opslimit, 32768);
  const r = 8;
  const log2Below = (maxN: number) => {
    let n = 1;
    while (n < 63 && 2 ** n <= Math.floor(maxN / 2)) n++;
    return n;
  };
  if (ops < Math.floor(memlimit / 32)) return { N: 2 ** log2Below(Math.floor(ops / (r * 4))), r, p: 1 };
  const log2N = log2Below(Math.floor(memlimit / (r * 128)));
  const maxrp = Math.min(Math.floor(Math.floor(ops / 4) / 2 ** log2N), 0x3fffffff);
  return { N: 2 ** log2N, r, p: Math.floor(maxrp / r) };
}

function base64Text(text: string, what: string): string {
  const t = text.trim();
  if (t.startsWith("untrusted comment:")) return t;
  if (t === "" || t.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(t)) throw new Error(`${what} is neither a minisign secret key nor its base64`);
  return Buffer.from(t, "base64").toString("utf8");
}

function safeNumber(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`the update key's ${what} is too large to be real`);
  return Number(value);
}

export function readSecretKey(encoded: string, password: string): SecretKey {
  const lines = base64Text(encoded, "LOKI_UPDATE_KEY").split(/\r?\n/);
  const [comment, line = ""] = lines;
  if (!comment.startsWith("untrusted comment:")) throw new Error("LOKI_UPDATE_KEY is not a minisign secret key file");
  const t = line.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t) || t.length % 4 !== 0) throw new Error("LOKI_UPDATE_KEY's second line is not base64");
  const bytes = Buffer.from(t, "base64");
  if (bytes.length !== SECRET_KEY_BYTES) throw new Error(`LOKI_UPDATE_KEY holds ${bytes.length} bytes, not a minisign secret key's ${SECRET_KEY_BYTES}`);
  const algorithm = bytes.subarray(0, 2).toString("latin1");
  const kdf = bytes.subarray(2, 4).toString("latin1");
  const checksumAlgorithm = bytes.subarray(4, 6).toString("latin1");
  if (algorithm !== SIGNATURE_ALGORITHM || checksumAlgorithm !== CHECKSUM_ALGORITHM) throw new Error("LOKI_UPDATE_KEY is not a minisign Ed25519 key");
  if (kdf !== SCRYPT && kdf !== UNENCRYPTED) throw new Error("LOKI_UPDATE_KEY is encrypted in a way minisign does not use");
  const salt = bytes.subarray(6, 6 + SALT_BYTES);
  const opslimit = safeNumber(bytes.readBigUInt64LE(6 + SALT_BYTES), "opslimit");
  const memlimit = safeNumber(bytes.readBigUInt64LE(14 + SALT_BYTES), "memlimit");
  const sealed = bytes.subarray(22 + SALT_BYTES);
  const open = Buffer.from(sealed);
  if (kdf === SCRYPT) {
    const { N, r, p } = scryptParams(opslimit, memlimit);
    const stream = scryptSync(Buffer.from(password, "utf8"), salt, ENCRYPTED_BYTES, { N, r, p, maxmem: 128 * r * (N + p + 2) + 1024 * 1024 });
    for (let i = 0; i < open.length; i++) open[i] ^= stream[i];
  }
  const keyId = open.subarray(0, KEY_ID_BYTES);
  const secret = open.subarray(KEY_ID_BYTES, KEY_ID_BYTES + SECRET_BYTES);
  const checksum = open.subarray(KEY_ID_BYTES + SECRET_BYTES);
  const expected = blake2b(Buffer.concat([bytes.subarray(0, 2), keyId, secret]), CHECKSUM_BYTES);
  if (!timingSafeEqual(checksum, expected))
    throw new Error(
      kdf === SCRYPT ? "LOKI_UPDATE_KEY_PASSWORD does not open LOKI_UPDATE_KEY: the key's checksum does not match" : "LOKI_UPDATE_KEY is damaged",
    );
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, secret.subarray(0, 32)]), format: "der", type: "pkcs8" });
  return { keyId: Buffer.from(keyId), privateKey };
}

const keyIdAsMinisignPrintsIt = (littleEndian: Uint8Array) => Buffer.from(littleEndian).reverse().toString("hex").toUpperCase();

export function checkPair(key: SecretKey, publicKey: string = UPDATE_PUBLIC_KEY): void {
  const trusted = parsePublicKey(publicKey);
  const der = (k: KeyObject) => k.export({ format: "der", type: "spki" });
  if (!trusted.keyId.equals(key.keyId) || !der(trusted.key).equals(der(createPublicKey(key.privateKey))))
    throw new Error(
      `LOKI_UPDATE_KEY is key ${keyIdAsMinisignPrintsIt(key.keyId)}, but loki's updater trusts key ${keyIdAsMinisignPrintsIt(trusted.keyId)}: no loki could verify what it signs`,
    );
}

export const trustedComment = (name: string, version: string, now: Date): string =>
  `timestamp:${Math.floor(now.getTime() / 1000)}\tfile:${name}\tversion:${version}`;

export function signUpdate(file: Uint8Array, name: string, version: string, key: SecretKey, now: Date): string {
  return signatureFile(file, { privateKey: key.privateKey, keyId: key.keyId, prehashed: false, trustedComment: trustedComment(name, version, now) });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version = "", ...files] = process.argv.slice(2);
  try {
    if (!/^\d+\.\d+\.\d+(-nightly\.\d+)?$/.test(version) || files.length === 0) throw new Error("usage: sign-update.ts <version> <file>...");
    const encoded = process.env.LOKI_UPDATE_KEY;
    if (!encoded) throw new Error("LOKI_UPDATE_KEY is not set: it is the base64 of loki's minisign secret key");
    const key = readSecretKey(encoded, process.env.LOKI_UPDATE_KEY_PASSWORD ?? "");
    checkPair(key);
    for (const file of files) {
      writeFileSync(`${file}.sig`, signUpdate(readFileSync(file), basename(file), version, key, new Date()));
      console.log(`sign-update: signed ${basename(file)} for ${version} with key ${keyIdAsMinisignPrintsIt(key.keyId)}`);
    }
  } catch (err) {
    console.error(`::error::sign-update: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
