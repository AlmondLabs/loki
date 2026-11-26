import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { blake2b512, createBlake2b512 } from "./blake2b.ts";

export const UPDATE_PUBLIC_KEY =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDk5NDhBMjgyMDBGMEUxMQpSV1FSRGc4Z0tJcVVDWTMzY09Zang3cnZXbXRmVmRsSnYwUHR5SnN1RnB5MWEzY0xML0Z0bGlPNQo=";

const ALGORITHM_BYTES = 2;
const KEY_ID_BYTES = 8;
const ED25519_BYTES = 32;
const SIGNATURE_BYTES = 64;
const ED25519 = "Ed";
const ED25519_PREHASHED = "ED";
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const TRUSTED = "trusted comment: ";

export interface MinisignKey {
  keyId: Buffer;
  key: KeyObject;
}

export interface MinisignSignature {
  prehashed: boolean;
  keyId: Buffer;
  signature: Buffer;
  trustedComment: string;
  globalSignature: Buffer;
}

// Outside (Node): Buffer.from quietly skips the characters it does not know, so a damaged file would still decode.
function decodeBase64(text: string, what: string): Buffer {
  const t = text.trim();
  if (t === "" || t.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(t)) throw new Error(`${what} is not base64`);
  return Buffer.from(t, "base64");
}

const keyIdAsMinisignPrintsIt = (littleEndian: Uint8Array) => Buffer.from(littleEndian).reverse().toString("hex").toUpperCase();

const ed25519Key = (raw: Uint8Array): KeyObject => createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });

export function parsePublicKey(base64: string): MinisignKey {
  const lines = decodeBase64(base64, "the public key").toString("utf8").split(/\r?\n/);
  const [comment, line] = lines;
  if (lines.length < 2 || !comment.startsWith("untrusted comment:")) throw new Error("the public key is not a minisign file");
  const bytes = decodeBase64(line, "the public key's second line");
  const algorithm = bytes.subarray(0, ALGORITHM_BYTES).toString("latin1");
  if (bytes.length !== ALGORITHM_BYTES + KEY_ID_BYTES + ED25519_BYTES || algorithm !== ED25519) throw new Error("the public key is not a minisign Ed25519 key");
  return { keyId: bytes.subarray(ALGORITHM_BYTES, ALGORITHM_BYTES + KEY_ID_BYTES), key: ed25519Key(bytes.subarray(ALGORITHM_BYTES + KEY_ID_BYTES)) };
}

export function parseSignature(base64: string): MinisignSignature {
  const lines = decodeBase64(base64, "the update's signature").toString("utf8").split(/\r?\n/);
  const [comment, line, trusted, global] = lines;
  if (lines.length < 4 || !comment.startsWith("untrusted comment:") || !trusted.startsWith(TRUSTED))
    throw new Error("the update's signature is not a minisign signature");
  const bytes = decodeBase64(line, "the update's signature");
  const algorithm = bytes.subarray(0, ALGORITHM_BYTES).toString("latin1");
  if (bytes.length !== ALGORITHM_BYTES + KEY_ID_BYTES + SIGNATURE_BYTES || (algorithm !== ED25519 && algorithm !== ED25519_PREHASHED))
    throw new Error("the update's signature is not a minisign Ed25519 signature");
  const globalSignature = decodeBase64(global, "the signature's trusted comment signature");
  if (globalSignature.length !== SIGNATURE_BYTES) throw new Error("the signature's trusted comment signature is not an Ed25519 signature");
  return {
    prehashed: algorithm === ED25519_PREHASHED,
    keyId: bytes.subarray(ALGORITHM_BYTES, ALGORITHM_BYTES + KEY_ID_BYTES),
    signature: bytes.subarray(ALGORITHM_BYTES + KEY_ID_BYTES),
    trustedComment: trusted.slice(TRUSTED.length),
    globalSignature,
  };
}

export function signedVersion(trustedComment: string): string | null {
  const field = trustedComment.split("\t").find((f) => f.startsWith("version:"));
  return field ? field.slice("version:".length) : null;
}

export interface UpdateVerifier {
  update: (chunk: Uint8Array) => void;
  verify: (file: Uint8Array | string) => void;
}

export function updateVerifier(signatureBase64: string, announced: string, publicKey: string = UPDATE_PUBLIC_KEY): UpdateVerifier {
  const key = parsePublicKey(publicKey);
  const sig = parseSignature(signatureBase64);
  if (!sig.keyId.equals(key.keyId))
    throw new Error(`the update is signed by key ${keyIdAsMinisignPrintsIt(sig.keyId)}, not loki's update key ${keyIdAsMinisignPrintsIt(key.keyId)}`);
  const hash = sig.prehashed ? createBlake2b512() : null;
  return {
    update: (chunk) => hash?.update(chunk),
    verify: (file) => {
      const target = hash ? hash.digest() : typeof file === "string" ? readFileSync(file) : file;
      if (!verify(null, target, key.key, sig.signature)) throw new Error("the update's signature does not match the downloaded file");
      if (!verify(null, Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, "utf8")]), key.key, sig.globalSignature))
        throw new Error("the signature's trusted comment does not verify");
      const version = signedVersion(sig.trustedComment);
      if (version === null) throw new Error("the signature names no version");
      if (version !== announced) throw new Error(`the signature is for version ${version}, but the release announces ${announced}`);
    },
  };
}

export function verifyUpdate(file: Uint8Array, signatureBase64: string, announced: string, publicKey: string = UPDATE_PUBLIC_KEY): void {
  const verifier = updateVerifier(signatureBase64, announced, publicKey);
  verifier.update(file);
  verifier.verify(file);
}

export interface Signing {
  privateKey: KeyObject;
  keyId: Uint8Array;
  prehashed: boolean;
  trustedComment: string;
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

export function publicKeyFile(publicKey: KeyObject, keyId: Uint8Array): string {
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_ED25519_PREFIX.length);
  const line = Buffer.concat([Buffer.from(ED25519, "latin1"), keyId, raw]);
  return base64(Buffer.from(`untrusted comment: minisign public key: ${keyIdAsMinisignPrintsIt(keyId)}\n${base64(line)}\n`));
}

export function signatureFile(file: Uint8Array, { privateKey, keyId, prehashed, trustedComment }: Signing): string {
  const signature = sign(null, prehashed ? blake2b512(file) : file, privateKey);
  const line = Buffer.concat([Buffer.from(prehashed ? ED25519_PREHASHED : ED25519, "latin1"), keyId, signature]);
  const global = sign(null, Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]), privateKey);
  return base64(Buffer.from(`untrusted comment: signature from loki's release key\n${base64(line)}\n${TRUSTED}${trustedComment}\n${base64(global)}\n`));
}
