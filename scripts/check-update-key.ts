import { readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePublicKey, parseSignature, signedVersion, UPDATE_PUBLIC_KEY, verifyUpdate } from "../desktop/update/minisign.ts";

export interface KeyCheck {
  problems: string[];
  signed: string[];
}

export interface KeyCheckFiles {
  text: (path: string) => string;
  bytes: (path: string) => Uint8Array;
}

const keyIdAsMinisignPrintsIt = (littleEndian: Uint8Array) => Buffer.from(littleEndian).reverse().toString("hex").toUpperCase();
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const publicKeyId = (publicKey: string): string => keyIdAsMinisignPrintsIt(parsePublicKey(publicKey).keyId);
export const signatureKeyId = (sig: string): string => keyIdAsMinisignPrintsIt(parseSignature(sig).keyId);

export function checkUpdateKey({
  sigs,
  files,
  version,
  publicKey = UPDATE_PUBLIC_KEY,
}: {
  sigs: string[];
  files: KeyCheckFiles;
  version?: string;
  publicKey?: string;
}): KeyCheck {
  let expected: string;
  try {
    expected = publicKeyId(publicKey);
  } catch (e) {
    return { problems: [`UPDATE_PUBLIC_KEY in desktop/update/minisign.ts is not a minisign public key (${messageOf(e)})`], signed: [] };
  }
  if (sigs.length === 0) return { problems: ["no update signature to check: nothing was signed"], signed: [] };
  const result: KeyCheck = { problems: [], signed: [] };
  for (const path of sigs) {
    try {
      if (!path.endsWith(".sig")) throw new Error("is not a .sig file beside the file it signs");
      const sig = files.text(path).trim();
      const actual = signatureKeyId(sig);
      if (actual !== expected) {
        result.problems.push(
          `${path}: signed by key ${actual}, but loki's updater trusts key ${expected}; no loki could verify it (LOKI_UPDATE_KEY and UPDATE_PUBLIC_KEY must be one pair)`,
        );
        continue;
      }
      const signedFor = signedVersion(parseSignature(sig).trustedComment);
      if (signedFor === null) throw new Error("the signature names no version");
      verifyUpdate(files.bytes(path.replace(/\.sig$/, "")), sig, version ?? signedFor, publicKey);
      result.signed.push(`${basename(path)}: signed by update key ${actual} for ${signedFor}`);
    } catch (e) {
      result.problems.push(`${path}: ${messageOf(e)}`);
    }
  }
  return result;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--version");
  const version = at === -1 ? undefined : args[at + 1];
  const sigs = at === -1 ? args : args.filter((_, i) => i !== at && i !== at + 1);
  const { problems, signed } = checkUpdateKey({ sigs, version, files: { text: (path) => readFileSync(path, "utf8"), bytes: (path) => readFileSync(path) } });
  for (const line of signed) console.log(line);
  for (const line of problems) console.error(`::error::${line}`);
  if (problems.length > 0) process.exit(1);
}
