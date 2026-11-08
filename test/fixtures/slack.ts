import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * A Slack desktop app's data folder, built in code for tests on any system: its Local Storage LevelDB (a log file and a
 * snappy-compressed table, the two shapes Chromium leaves on disk) holding `localConfig_v2`, and its Cookies database
 * holding the `d` cookie encrypted the way Chromium does on macOS. Every token is made up. The byte layouts follow
 * LevelDB's and Chromium's published formats, written here independently of the reader under test.
 */

/** The keychain password the fixture encrypts the cookie with. */
export const SAFE_STORAGE_PASSWORD = "fixture-safe-storage-password";
/** The `d` cookie as Slack stores it: URL-encoded. */
export const COOKIE_STORED = "xoxd-fixture%2Bcookie%2Fvalue%3D%3D";
/** The same cookie decoded, as a request sends it once encoded again. */
export const COOKIE_DECODED = "xoxd-fixture+cookie/value==";

/** Two signed-in workspaces, as Slack's localConfig keeps them, plus one entry without a desktop token. */
export const LOCAL_CONFIG = {
  teams: {
    T0ACME: { id: "T0ACME", name: "Acme", url: "https://acme.slack.com/", domain: "acme", token: "xoxc-acme-1111-2222-3333", user_id: "U0ME" },
    T0BETA: { id: "T0BETA", name: "Beta Café", url: "https://beta-cafe.slack.com/", domain: "beta-cafe", token: "xoxc-beta-4444-5555-6666", user_id: "U0YOU" },
    T0BOT: { id: "T0BOT", name: "Not a session", url: "https://bot.slack.com/", token: "xoxb-not-a-desktop-token" },
  },
  lastActiveTeamId: "T0ACME",
};

/** An older localConfig, written before the person signed in to Beta: a reader must prefer the newer one. */
export const OLDER_LOCAL_CONFIG = { teams: { T0ACME: LOCAL_CONFIG.teams.T0ACME } };

/** Where a direct-download Slack keeps its data under a home folder; the App Store build's container is the other. */
export const directDownloadDir = (home: string) => join(home, "Library", "Application Support", "Slack");
/** Where the Mac App Store build of Slack keeps its data under a home folder. */
export const appStoreDir = (home: string) =>
  join(home, "Library", "Containers", "com.tinyspeck.slackmacgap", "Data", "Library", "Application Support", "Slack");

/** Chromium's Local Storage key for one item of app.slack.com. */
export const storageKey = (name: string) => Buffer.concat([Buffer.from("_https://app.slack.com"), Buffer.from([0, 1]), Buffer.from(name)]);

/** A Local Storage value: Chromium writes 1 then Latin-1 when every character fits, else 0 then UTF-16. */
export function storageValue(text: string, format: "latin1" | "utf16" = "latin1"): Buffer {
  return format === "latin1" ? Buffer.concat([Buffer.from([1]), Buffer.from(text, "latin1")]) : Buffer.concat([Buffer.from([0]), Buffer.from(text, "utf16le")]);
}

function varint(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

/**
 * Snappy's raw format, from its format description: the length, then literals and back-references. This encoder looks
 * back for a 4-byte match so the reader's copy path is exercised, not only literals.
 */
export function snappyCompress(input: Buffer): Buffer {
  const parts: Buffer[] = [varint(input.length)];
  const literal = (from: number, to: number) => {
    let start = from;
    while (start < to) {
      const len = Math.min(to - start, 60);
      parts.push(Buffer.from([(len - 1) << 2]), input.subarray(start, start + len));
      start += len;
    }
  };
  let pending = 0;
  let i = 0;
  while (i < input.length) {
    let bestLen = 0;
    let bestOff = 0;
    for (let j = Math.max(0, i - 2000); j < i; j++) {
      let len = 0;
      while (i + len < input.length && input[j + len] === input[i + len] && len < 64) len++;
      if (len > bestLen) {
        bestLen = len;
        bestOff = i - j;
      }
    }
    if (bestLen >= 4) {
      literal(pending, i);
      // A copy with a two-byte offset: tag 2, length - 1 in the upper six bits.
      parts.push(Buffer.from([((bestLen - 1) << 2) | 2, bestOff & 0xff, bestOff >> 8]));
      i += bestLen;
      pending = i;
    } else i++;
  }
  literal(pending, input.length);
  return Buffer.concat(parts);
}

/** One write in a LevelDB batch: a value, or a deletion. */
export interface LevelWrite {
  key: Buffer;
  value: Buffer | null;
}

/** A LevelDB log file holding one write batch per element, starting at sequence `seq`; records split across 32 KiB blocks. */
export function levelLog(batches: LevelWrite[][], seq = 1): Buffer {
  const BLOCK = 32768;
  const out: Buffer[] = [];
  let at = 0;
  let next = seq;
  for (const batch of batches) {
    const head = Buffer.alloc(12);
    head.writeBigUInt64LE(BigInt(next));
    head.writeUInt32LE(batch.length, 8);
    next += batch.length;
    const body = Buffer.concat([
      head,
      ...batch.map((w) =>
        w.value
          ? Buffer.concat([Buffer.from([1]), varint(w.key.length), w.key, varint(w.value.length), w.value])
          : Buffer.concat([Buffer.from([0]), varint(w.key.length), w.key]),
      ),
    ]);
    let left = body;
    let first = true;
    let done = false;
    while (!done) {
      const room = BLOCK - (at % BLOCK);
      if (room < 7) {
        out.push(Buffer.alloc(room));
        at += room;
        continue;
      }
      const take = Math.min(room - 7, left.length);
      const last = take === left.length;
      const type = first && last ? 1 : first ? 2 : last ? 4 : 3;
      const header = Buffer.alloc(7);
      header.writeUInt16LE(take, 4);
      header[6] = type;
      out.push(header, left.subarray(0, take));
      at += 7 + take;
      left = left.subarray(take);
      first = false;
      done = last;
    }
  }
  return Buffer.concat(out);
}

function block(entries: Array<{ key: Buffer; value: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  let prev: Buffer = Buffer.alloc(0);
  for (const e of entries) {
    let shared = 0;
    while (shared < prev.length && shared < e.key.length && prev[shared] === e.key[shared]) shared++;
    parts.push(varint(shared), varint(e.key.length - shared), varint(e.value.length), e.key.subarray(shared), e.value);
    prev = e.key;
  }
  return Buffer.concat([...parts, u32(0), u32(1)]);
}

/** A LevelDB table (.ldb): each entry's user key gets the 8-byte trailer of its sequence and kind; blocks snappy-compressed when asked. */
export function levelTable(entries: Array<{ key: Buffer; value: Buffer; seq: number }>, opts: { snappy: boolean } = { snappy: true }): Buffer {
  const internal = entries.map((e) => {
    const trailer = Buffer.alloc(8);
    trailer.writeBigUInt64LE((BigInt(e.seq) << 8n) | 1n);
    return { key: Buffer.concat([e.key, trailer]), value: e.value };
  });
  const out: Buffer[] = [];
  let at = 0;
  const put = (raw: Buffer) => {
    const body = opts.snappy ? snappyCompress(raw) : raw;
    const handle = Buffer.concat([varint(at), varint(body.length)]);
    out.push(body, Buffer.from([opts.snappy ? 1 : 0]), u32(0));
    at += body.length + 5;
    return handle;
  };
  // One data block per entry, so the index has several handles to follow.
  const index = internal.map((e) => ({ key: e.key, value: put(block([e])) }));
  const meta = put(block([]));
  const indexHandle = put(block(index));
  const footer = Buffer.alloc(48);
  Buffer.concat([meta, indexHandle]).copy(footer);
  Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]).copy(footer, 40);
  return Buffer.concat([...out, footer]);
}

/** The cookie's encrypted_value as Chromium writes it on macOS: "v10", then AES-128-CBC; meta version 24 and later prefix the host's SHA-256. */
export function encryptCookie(value: string, opts: { password?: string; host?: string; domainHash?: boolean } = {}): Buffer {
  const key = pbkdf2Sync(opts.password ?? SAFE_STORAGE_PASSWORD, "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  const plain =
    opts.domainHash === false
      ? Buffer.from(value)
      : Buffer.concat([
          createHash("sha256")
            .update(opts.host ?? ".slack.com")
            .digest(),
          Buffer.from(value),
        ]);
  return Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]);
}

/** A Chromium Cookies database with Slack's `d` cookie, and an unrelated cookie a reader must skip. */
export function writeCookies(file: string, opts: { password?: string; domainHash?: boolean } = {}): void {
  const db = new DatabaseSync(file);
  try {
    db.exec("CREATE TABLE meta (key TEXT NOT NULL UNIQUE PRIMARY KEY, value TEXT)");
    db.exec("CREATE TABLE cookies (host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, encrypted_value BLOB NOT NULL)");
    db.prepare("INSERT INTO meta (key, value) VALUES ('version', ?)").run(opts.domainHash === false ? "21" : "24");
    const insert = db.prepare("INSERT INTO cookies (host_key, name, value, encrypted_value) VALUES (?, ?, '', ?)");
    insert.run(".slack.com", "d", encryptCookie(COOKIE_STORED, opts));
    insert.run(".example.com", "d", encryptCookie("not-slack", opts));
  } finally {
    db.close();
  }
}

/**
 * A whole Slack data folder at `dir`: a log with the older localConfig, a table with the current one (a later
 * sequence), a LOCK file as a running Slack holds, and the Cookies database in Network/.
 */
export function writeSlackDir(dir: string, opts: { password?: string; config?: unknown } = {}): void {
  const leveldb = join(dir, "Local Storage", "leveldb");
  mkdirSync(leveldb, { recursive: true });
  mkdirSync(join(dir, "Network"), { recursive: true });
  const key = storageKey("localConfig_v2");
  writeFileSync(
    join(leveldb, "000003.log"),
    levelLog([[{ key: storageKey("unrelated"), value: storageValue("x") }], [{ key, value: storageValue(JSON.stringify(OLDER_LOCAL_CONFIG)) }]], 10),
  );
  writeFileSync(join(leveldb, "000005.ldb"), levelTable([{ key, value: storageValue(JSON.stringify(opts.config ?? LOCAL_CONFIG)), seq: 50 }]));
  writeFileSync(join(leveldb, "LOCK"), "");
  writeCookies(join(dir, "Network", "Cookies"), { password: opts.password });
}
