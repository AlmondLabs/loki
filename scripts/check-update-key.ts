/**
 * The update key's check (plan 2026-11-15-2319, U4): every updater signature a release build made must come from the
 * key compiled into loki, `plugins.updater.pubkey` in src-tauri/tauri.conf.json. tauri-cli only warns when the two
 * differ, and a loki built that way can never verify an update again, so the release stops here instead. Run by
 * .github/workflows/release.yml after each build, with the build's `.sig` files:
 *   node --experimental-strip-types scripts/check-update-key.ts src-tauri/target/release/bundle/nsis/loki_x64-setup.exe.sig
 *
 * Both are minisign files, stored as base64 of the file's text. The public key's second line is base64 of 42 bytes:
 * the algorithm `Ed`, the 8-byte key id and the 32-byte key. A signature's second line is base64 of 74 bytes: the
 * algorithm (`Ed`, or `ED` when the file was hashed first), the key id and the 64-byte signature. Only the key ids are
 * compared: the bundler has already signed, and the plugin verifies the signature itself.
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CONFIG = fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url));

export interface KeyCheck {
  problems: string[];
  signed: string[];
}

/** Strict base64: Buffer.from would quietly skip the characters it does not know, and decode the placeholder. */
function decodeBase64(text: string, what: string): Buffer {
  const t = text.trim();
  if (t === "" || t.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(t)) throw new Error(`${what} is not base64`);
  return Buffer.from(t, "base64");
}

/** The key id in a minisign file's second line, as minisign prints it: the 8 bytes as a little-endian number, in hex. */
function keyIdIn(file: string, what: string, length: number, algorithms: string[]): string {
  const lines = decodeBase64(file, what).toString("utf8").split(/\r?\n/);
  const [comment, second] = lines;
  if (lines.length < 2 || !comment.startsWith("untrusted comment:")) throw new Error(`${what} is not a minisign file`);
  const line = decodeBase64(second, `${what}'s second line`);
  const algorithm = line.subarray(0, 2).toString("latin1");
  if (line.length !== length || !algorithms.includes(algorithm)) throw new Error(`${what} is not a minisign Ed25519 key or signature`);
  return Buffer.from(line.subarray(2, 10)).reverse().toString("hex").toUpperCase();
}

export function publicKeyId(pubkey: string): string {
  return keyIdIn(pubkey, "the public key", 42, ["Ed"]);
}

export function signatureKeyId(sig: string): string {
  return keyIdIn(sig, "the signature", 74, ["Ed", "ED"]);
}

function pubkeyIn(configText: string): string {
  const config: unknown = JSON.parse(configText);
  const plugins = typeof config === "object" && config !== null && "plugins" in config ? config.plugins : undefined;
  const updater = typeof plugins === "object" && plugins !== null && "updater" in plugins ? plugins.updater : undefined;
  const pubkey = typeof updater === "object" && updater !== null && "pubkey" in updater ? updater.pubkey : undefined;
  if (typeof pubkey !== "string") throw new Error("has no plugins.updater.pubkey");
  return pubkey;
}

export function checkUpdateKey(configPath: string, sigs: string[], read: (path: string) => string): KeyCheck {
  let expected: string;
  try {
    expected = publicKeyId(pubkeyIn(read(configPath)));
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return {
      problems: [`${configPath}: plugins.updater.pubkey is not loki's update public key (${why}); put in the one from \`tauri signer generate\``],
      signed: [],
    };
  }
  if (sigs.length === 0) return { problems: ["no updater signature to check: the build made no .sig file"], signed: [] };
  const result: KeyCheck = { problems: [], signed: [] };
  for (const path of sigs) {
    let actual: string;
    try {
      actual = signatureKeyId(read(path));
    } catch (e) {
      result.problems.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (actual === expected) result.signed.push(`${path}: signed by update key ${actual}`);
    else
      result.problems.push(
        `${path}: signed by key ${actual}, but tauri.conf.json's pubkey is key ${expected}; no loki built with this pubkey could verify it (TAURI_SIGNING_PRIVATE_KEY and plugins.updater.pubkey must be one pair)`,
      );
  }
  return result;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { problems, signed } = checkUpdateKey(CONFIG, process.argv.slice(2), (path) => readFileSync(path, "utf8"));
  for (const line of signed) console.log(line);
  for (const line of problems) console.error(`::error::${line}`);
  if (problems.length > 0) process.exit(1);
}
