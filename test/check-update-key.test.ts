import { describe, expect, test } from "vitest";
import { checkUpdateKey, publicKeyId, signatureKeyId } from "../scripts/check-update-key.ts";

// Minisign files built here from known bytes, as `tauri signer generate` and the bundler write them: each is base64 of
const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64");
const id = (n: number) => Uint8Array.from({ length: 8 }, (_, i) => n + i);
const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);

const publicKey = (keyId: Uint8Array) => b64(`untrusted comment: minisign public key\n${b64(Buffer.concat([Buffer.from("Ed"), keyId, bytes(32, 7)]))}\n`);
const signature = (keyId: Uint8Array) =>
  b64(
    [
      "untrusted comment: signature from tauri secret key",
      b64(Buffer.concat([Buffer.from("ED"), keyId, bytes(64, 9)])),
      "trusted comment: timestamp:1763251200\tfile:loki.app.tar.gz",
      b64(bytes(64, 3)),
      "",
    ].join("\n"),
  );
const config = (pubkey: string) => JSON.stringify({ plugins: { updater: { pubkey, endpoints: [] } } });

const files = (all: Record<string, string>) => (path: string) => {
  if (!Object.hasOwn(all, path)) throw new Error(`ENOENT: ${path}`);
  return all[path];
};

describe("the update key check", () => {
  test("passes when every signature was made by the compiled-in key", () => {
    const read = files({
      "tauri.conf.json": config(publicKey(id(1))),
      "macos/loki.app.tar.gz.sig": signature(id(1)),
      "nsis/loki_1_x64-setup.exe.sig": signature(id(1)),
    });
    const result = checkUpdateKey("tauri.conf.json", ["macos/loki.app.tar.gz.sig", "nsis/loki_1_x64-setup.exe.sig"], read);
    expect(result.problems).toEqual([]);
    expect(result.signed).toHaveLength(2);
    // The key id as minisign prints it: the eight bytes read as a little-endian number, in hex.
    expect(publicKeyId(publicKey(id(1)))).toBe("0807060504030201");
    expect(signatureKeyId(signature(id(1)))).toBe("0807060504030201");
  });

  test("fails, naming the file, when a signature is from another key", () => {
    const read = files({
      "tauri.conf.json": config(publicKey(id(1))),
      "macos/loki.app.tar.gz.sig": signature(id(1)),
      "appimage/loki_1_amd64.AppImage.sig": signature(id(20)),
    });
    const result = checkUpdateKey("tauri.conf.json", ["macos/loki.app.tar.gz.sig", "appimage/loki_1_amd64.AppImage.sig"], read);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("appimage/loki_1_amd64.AppImage.sig");
    expect(result.problems[0]).toContain(signatureKeyId(signature(id(20))));
    expect(result.problems[0]).toContain(publicKeyId(publicKey(id(1))));
  });

  test("fails while the public key is still the placeholder, or is no minisign key", () => {
    for (const pubkey of ["REPLACE_WITH_THE_UPDATE_PUBLIC_KEY", b64("untrusted comment: minisign public key\n"), ""]) {
      const read = files({ "tauri.conf.json": config(pubkey), "a.sig": signature(id(1)) });
      const result = checkUpdateKey("tauri.conf.json", ["a.sig"], read);
      expect(result.problems, pubkey).toHaveLength(1);
      expect(result.problems[0]).toMatch(/plugins\.updater\.pubkey/);
    }
    expect(() => publicKeyId("REPLACE_WITH_THE_UPDATE_PUBLIC_KEY")).toThrow(/base64/);
  });

  test("fails when the build made no signature, or one cannot be read or decoded", () => {
    const read = files({ "tauri.conf.json": config(publicKey(id(1))), "bad.sig": b64("not a signature") });
    expect(checkUpdateKey("tauri.conf.json", [], read).problems[0]).toMatch(/no updater signature/);
    const missing = checkUpdateKey("tauri.conf.json", ["gone.sig"], read);
    expect(missing.problems[0]).toContain("gone.sig");
    const bad = checkUpdateKey("tauri.conf.json", ["bad.sig"], read);
    expect(bad.problems[0]).toContain("bad.sig");
    expect(checkUpdateKey("tauri.conf.json", ["a.sig"], files({ "tauri.conf.json": "{}", "a.sig": signature(id(1)) })).problems[0]).toMatch(
      /plugins\.updater\.pubkey/,
    );
  });
});
