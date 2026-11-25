import { generateKeyPairSync, randomBytes, scryptSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import { blake2b } from "../desktop/update/blake2b.ts";
import { parseSignature, publicKeyFile, signedVersion, verifyUpdate } from "../desktop/update/minisign.ts";
import { checkPair, readSecretKey, scryptParams, signUpdate, trustedComment } from "../scripts/sign-update.ts";

const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64");
const u64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

const CHEAP = { opslimit: 32768, memlimit: 16 * 1024 * 1024, N: 1024, r: 8, p: 1 };

function minisignSecretKey(password: string | null, keyId: Buffer = randomBytes(8)) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const secret = Buffer.concat([seed, raw]);
  const checksum = blake2b(Buffer.concat([Buffer.from("Ed"), keyId, secret]), 32);
  const sealed = Buffer.concat([keyId, secret, checksum]);
  const salt = randomBytes(32);
  if (password !== null) {
    const stream = scryptSync(password, salt, sealed.length, { N: CHEAP.N, r: CHEAP.r, p: CHEAP.p });
    for (let i = 0; i < sealed.length; i++) sealed[i] ^= stream[i];
  }
  const line = Buffer.concat([
    Buffer.from("Ed"),
    Buffer.from(password === null ? "\0\0" : "Sc", "latin1"),
    Buffer.from("B2"),
    salt,
    u64(CHEAP.opslimit),
    u64(CHEAP.memlimit),
    sealed,
  ]);
  return {
    secretKey: b64(`untrusted comment: minisign encrypted secret key\n${b64(line)}\n`),
    publicKey: publicKeyFile(publicKey, keyId),
  };
}

describe("signing an update file with loki's minisign key", () => {
  const file = Buffer.from("the Mac's update archive");
  const now = new Date("2026-11-25T12:00:00Z");

  test("an encrypted key opens with its password, and its signature verifies against the updater's key, naming the version", () => {
    const { secretKey, publicKey } = minisignSecretKey("correct horse");
    const key = readSecretKey(secretKey, "correct horse");
    checkPair(key, publicKey);
    const sig = signUpdate(file, "loki.app.tar.gz", "2026.1125.0", key, now);
    expect(() => verifyUpdate(file, sig, "2026.1125.0", publicKey)).not.toThrow();
    const parsed = parseSignature(sig);
    expect(parsed.prehashed).toBe(false);
    expect(parsed.trustedComment).toBe("timestamp:1795608000\tfile:loki.app.tar.gz\tversion:2026.1125.0");
    expect(signedVersion(parsed.trustedComment)).toBe("2026.1125.0");
    expect(trustedComment("loki_1_x64-setup.exe", "2026.1125.0-nightly.4900", now)).toBe(
      "timestamp:1795608000\tfile:loki_1_x64-setup.exe\tversion:2026.1125.0-nightly.4900",
    );
  });

  test("a signature for one version does not pass for another, and one for another file does not pass at all", () => {
    const { secretKey, publicKey } = minisignSecretKey("pw");
    const sig = signUpdate(file, "loki.app.tar.gz", "2026.1125.0", readSecretKey(secretKey, "pw"), now);
    expect(() => verifyUpdate(file, sig, "2026.1125.1", publicKey)).toThrow(/for version 2026\.1125\.0/);
    expect(() => verifyUpdate(Buffer.from("something else"), sig, "2026.1125.0", publicKey)).toThrow(/does not match/);
  });

  test("a wrong password fails, saying the password does not open the key", () => {
    const { secretKey } = minisignSecretKey("right");
    expect(() => readSecretKey(secretKey, "wrong")).toThrow("LOKI_UPDATE_KEY_PASSWORD does not open LOKI_UPDATE_KEY: the key's checksum does not match");
    expect(() => readSecretKey(secretKey, "")).toThrow(/does not open/);
  });

  test("an unencrypted key, and a key file given as text rather than base64, open too", () => {
    const { secretKey, publicKey } = minisignSecretKey(null);
    const text = Buffer.from(secretKey, "base64").toString("utf8");
    for (const given of [secretKey, text]) {
      const key = readSecretKey(given, "ignored");
      checkPair(key, publicKey);
      expect(() => verifyUpdate(file, signUpdate(file, "f", "1.2.3", key, now), "1.2.3", publicKey)).not.toThrow();
    }
  });

  test("a key that is not the pair of the updater's public key is refused before anything is signed", () => {
    const signing = minisignSecretKey("pw");
    const other = minisignSecretKey("pw");
    const key = readSecretKey(signing.secretKey, "pw");
    expect(() => checkPair(key)).toThrow(/loki's updater trusts key/);
    expect(() => checkPair(key, other.publicKey)).toThrow(/no loki could verify what it signs/);
    const sameIdOtherKey = minisignSecretKey("pw", Buffer.from(key.keyId));
    expect(() => checkPair(key, sameIdOtherKey.publicKey)).toThrow(/trusts key/);
  });

  test("a damaged or foreign key file fails with what is wrong with it", () => {
    expect(() => readSecretKey("not base64!", "")).toThrow(/neither a minisign secret key/);
    expect(() => readSecretKey(b64("untrusted comment: x\nAAAA\n"), "")).toThrow(/holds 3 bytes/);
    expect(() => readSecretKey(b64("a public key\nAAAA\n"), "")).toThrow(/not a minisign secret key file/);
  });

  test("scrypt's cost comes from the key's opslimit and memlimit as libsodium picks it", () => {
    expect(scryptParams(CHEAP.opslimit, CHEAP.memlimit)).toEqual({ N: CHEAP.N, r: CHEAP.r, p: CHEAP.p });
    expect(scryptParams(524288, 16777216)).toEqual({ N: 2 ** 14, r: 8, p: 1 });
    expect(scryptParams(33554432, 1073741824)).toEqual({ N: 2 ** 20, r: 8, p: 1 });
    expect(scryptParams(1, 1)).toEqual({ N: 2, r: 8, p: 512 });
  });

  test("the checksum is BLAKE2b with a 32-byte digest, as libsodium's crypto_generichash makes it", () => {
    expect(Buffer.from(blake2b(Buffer.from("abc"), 32)).toString("hex")).toBe("bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319");
  });
});
