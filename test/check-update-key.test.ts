import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import { publicKeyFile, signatureFile, UPDATE_PUBLIC_KEY } from "../desktop/update/minisign.ts";
import { checkUpdateKey, publicKeyId, signatureKeyId } from "../scripts/check-update-key.ts";

const id = (n: number) => Uint8Array.from({ length: 8 }, (_, i) => n + i);

function updateKey(keyId: Uint8Array) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKeyFile(publicKey, keyId),
    sign: (file: string, version: string) =>
      signatureFile(Buffer.from(file), { privateKey, keyId, prehashed: false, trustedComment: `timestamp:1795608000\tfile:f\tversion:${version}` }),
  };
}

const files = (all: Record<string, string>) => ({
  text: (path: string) => {
    if (!Object.hasOwn(all, path)) throw new Error(`ENOENT: ${path}`);
    return all[path];
  },
  bytes: (path: string) => {
    if (!Object.hasOwn(all, path)) throw new Error(`ENOENT: ${path}`);
    return Buffer.from(all[path]);
  },
});

describe("the update key check", () => {
  const loki = updateKey(id(1));

  test("passes when every file verifies against the updater's key, for the version its signature names", () => {
    const read = files({
      "loki.app.tar.gz": "mac",
      "loki.app.tar.gz.sig": loki.sign("mac", "2026.1125.0"),
      "loki_2026.1125.0_x64-setup.exe": "exe",
      "loki_2026.1125.0_x64-setup.exe.sig": loki.sign("exe", "2026.1125.0"),
    });
    const result = checkUpdateKey({ sigs: ["loki.app.tar.gz.sig", "loki_2026.1125.0_x64-setup.exe.sig"], files: read, publicKey: loki.publicKey });
    expect(result.problems).toEqual([]);
    expect(result.signed).toEqual([
      "loki.app.tar.gz.sig: signed by update key 0807060504030201 for 2026.1125.0",
      "loki_2026.1125.0_x64-setup.exe.sig: signed by update key 0807060504030201 for 2026.1125.0",
    ]);
    expect(publicKeyId(loki.publicKey)).toBe("0807060504030201");
    expect(signatureKeyId(loki.sign("mac", "1"))).toBe("0807060504030201");
  });

  test("fails, naming the file and both keys, when a signature is from another key", () => {
    const stranger = updateKey(id(20));
    const read = files({ "a.AppImage": "linux", "a.AppImage.sig": stranger.sign("linux", "2026.1125.0") });
    const result = checkUpdateKey({ sigs: ["a.AppImage.sig"], files: read, publicKey: loki.publicKey });
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("a.AppImage.sig");
    expect(result.problems[0]).toContain(signatureKeyId(stranger.sign("x", "1")));
    expect(result.problems[0]).toContain(publicKeyId(loki.publicKey));
  });

  test("fails when the file changed after signing, or the signature names another version than the release", () => {
    const read = files({ "f.exe": "changed", "f.exe.sig": loki.sign("original", "2026.1125.0"), "g.exe": "g", "g.exe.sig": loki.sign("g", "2026.1124.0") });
    expect(checkUpdateKey({ sigs: ["f.exe.sig"], files: read, publicKey: loki.publicKey }).problems[0]).toMatch(/f\.exe\.sig: .*does not match/);
    expect(checkUpdateKey({ sigs: ["g.exe.sig"], files: read, publicKey: loki.publicKey, version: "2026.1125.0" }).problems[0]).toMatch(
      /signature is for version 2026\.1124\.0/,
    );
  });

  test("fails when nothing was signed, or a signature cannot be read, decoded or matched to its file", () => {
    const read = files({ "bad.sig": Buffer.from("not a signature").toString("base64"), "lonely.exe.sig": loki.sign("x", "1") });
    expect(checkUpdateKey({ sigs: [], files: read, publicKey: loki.publicKey }).problems[0]).toMatch(/no update signature/);
    expect(checkUpdateKey({ sigs: ["gone.sig"], files: read, publicKey: loki.publicKey }).problems[0]).toContain("gone.sig");
    expect(checkUpdateKey({ sigs: ["bad.sig"], files: read, publicKey: loki.publicKey }).problems[0]).toContain("bad.sig");
    expect(checkUpdateKey({ sigs: ["lonely.exe.sig"], files: read, publicKey: loki.publicKey }).problems[0]).toContain("ENOENT: lonely.exe");
    expect(checkUpdateKey({ sigs: ["lonely.exe"], files: read, publicKey: loki.publicKey }).problems[0]).toMatch(/not a \.sig file/);
  });

  test("checks against the key compiled into the updater by default, and names it when it is no minisign key", () => {
    const read = files({ "a.exe": "a", "a.exe.sig": loki.sign("a", "1") });
    expect(checkUpdateKey({ sigs: ["a.exe.sig"], files: read }).problems[0]).toContain(`trusts key ${publicKeyId(UPDATE_PUBLIC_KEY)}`);
    expect(checkUpdateKey({ sigs: ["a.exe.sig"], files: read, publicKey: "REPLACE_ME" }).problems[0]).toMatch(
      /UPDATE_PUBLIC_KEY .* is not a minisign public key/,
    );
  });
});
