import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  parsePublicKey,
  parseSignature,
  publicKeyFile,
  signatureFile,
  signedVersion,
  UPDATE_PUBLIC_KEY,
  updateVerifier,
  verifyUpdate,
} from "../desktop/update/minisign.ts";

const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64");

interface TestKey {
  privateKey: KeyObject;
  keyId: Buffer;
  publicKey: string;
}

function testKey(keyId: Buffer = randomBytes(8)): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const line = Buffer.concat([Buffer.from("Ed"), keyId, raw]);
  return { privateKey, keyId, publicKey: b64(`untrusted comment: minisign public key: test\n${b64(line)}\n`) };
}

function signByHand(file: Uint8Array, key: TestKey, algorithm: "Ed" | "ED", trustedComment: string): string {
  const message = algorithm === "ED" ? createHash("blake2b512").update(file).digest() : file;
  const signature = sign(null, message, key.privateKey);
  const global = sign(null, Buffer.concat([signature, Buffer.from(trustedComment)]), key.privateKey);
  const line = Buffer.concat([Buffer.from(algorithm), key.keyId, signature]);
  return b64(`untrusted comment: signature from minisign secret key\n${b64(line)}\ntrusted comment: ${trustedComment}\n${b64(global)}\n`);
}

const file = Buffer.from("loki-macos-arm64.app.tar.gz, as downloaded");
const comment = (version: string) => `timestamp:1795000000\tfile:loki-macos-arm64.app.tar.gz\tversion:${version}`;

describe("loki's update key", () => {
  test("is the minisign Ed25519 key the Tauri app trusts, key 09948A28200F0E11", () => {
    const key = parsePublicKey(UPDATE_PUBLIC_KEY);
    expect(Buffer.from(key.keyId).reverse().toString("hex").toUpperCase()).toBe("09948A28200F0E11");
    expect(key.key.asymmetricKeyType).toBe("ed25519");
  });
});

describe("an update's minisign signature", () => {
  test.each(["Ed", "ED"] as const)("%s: a signature by the key, naming the announced version, verifies", (algorithm) => {
    const key = testKey();
    expect(() => verifyUpdate(file, signByHand(file, key, algorithm, comment("2026.1125.0")), "2026.1125.0", key.publicKey)).not.toThrow();
    expect(parseSignature(signByHand(file, key, algorithm, comment("1"))).prehashed).toBe(algorithm === "ED");
  });

  test.each(["Ed", "ED"] as const)("%s: a file changed after signing fails", (algorithm) => {
    const key = testKey();
    const sig = signByHand(file, key, algorithm, comment("2026.1125.0"));
    expect(() => verifyUpdate(Buffer.from("something else"), sig, "2026.1125.0", key.publicKey)).toThrow("does not match the downloaded file");
  });

  test("a signature from another key fails, by its key id or, with a forged id, by the signature itself", () => {
    const ours = testKey();
    const theirs = testKey();
    expect(() => verifyUpdate(file, signByHand(file, theirs, "ED", comment("1.0.0")), "1.0.0", ours.publicKey)).toThrow(
      /signed by key [0-9A-F]{16}, not loki's update key/,
    );
    const forger = testKey(ours.keyId);
    expect(() => verifyUpdate(file, signByHand(file, forger, "ED", comment("1.0.0")), "1.0.0", ours.publicKey)).toThrow("does not match the downloaded file");
  });

  test("a trusted comment changed after signing fails", () => {
    const key = testKey();
    const text = Buffer.from(signByHand(file, key, "Ed", comment("2026.1119.0")), "base64").toString("utf8");
    const changed = b64(text.replace("version:2026.1119.0", "version:2026.1125.0"));
    expect(() => verifyUpdate(file, changed, "2026.1125.0", key.publicKey)).toThrow("trusted comment does not verify");
  });

  test("a valid signature for another version, or naming none, fails", () => {
    const key = testKey();
    expect(() => verifyUpdate(file, signByHand(file, key, "ED", comment("2026.1119.0")), "2026.1125.0", key.publicKey)).toThrow(
      "the signature is for version 2026.1119.0, but the release announces 2026.1125.0",
    );
    expect(() => verifyUpdate(file, signByHand(file, key, "ED", "timestamp:1\tfile:x"), "2026.1125.0", key.publicKey)).toThrow(
      "the signature names no version",
    );
  });

  test("text that is not a minisign signature fails before any download", () => {
    const key = testKey();
    expect(() => updateVerifier("not base64!", "1.0.0", key.publicKey)).toThrow("not base64");
    expect(() => updateVerifier(b64("hello\nworld\n"), "1.0.0", key.publicKey)).toThrow("not a minisign signature");
    const short = b64(`untrusted comment: x\n${b64("EDshort")}\ntrusted comment: version:1\n${b64(randomBytes(64))}\n`);
    expect(() => updateVerifier(short, "1.0.0", key.publicKey)).toThrow("not a minisign Ed25519 signature");
  });

  test("a prehashed signature checks a file fed in as it downloads", () => {
    const key = testKey();
    const big = randomBytes(300_000);
    const verifier = updateVerifier(signByHand(big, key, "ED", comment("2.0.0")), "2.0.0", key.publicKey);
    for (let at = 0; at < big.length; at += 65_536) verifier.update(big.subarray(at, at + 65_536));
    expect(() => verifier.verify(big)).not.toThrow();
  });

  test("the version is the trusted comment's version field", () => {
    expect(signedVersion("timestamp:1\tfile:a\tversion:2026.1125.0-nightly.3")).toBe("2026.1125.0-nightly.3");
    expect(signedVersion("timestamp:1\tfile:a")).toBeNull();
  });

  test.each([true, false])("the files loki writes (prehashed: %s) read back as the hand-made ones do", (prehashed) => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keyId = randomBytes(8);
    const sig = signatureFile(file, { privateKey, keyId, prehashed, trustedComment: comment("3.0.0") });
    expect(() => verifyUpdate(file, sig, "3.0.0", publicKeyFile(publicKey, keyId))).not.toThrow();
    expect(() => verifyUpdate(file, sig, "3.0.0", testKey(keyId).publicKey)).toThrow();
  });
});
