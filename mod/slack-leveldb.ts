// The approach is ported from agent-slack (https://github.com/stablyai/agent-slack, src/lib/leveldb-reader.ts):
//
// MIT License. Copyright (c) 2026 Stably. Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following
// conditions: The above copyright notice and this permission notice shall be included in all copies or substantial
// portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { snappyUncompress } from "./slack-snappy.ts";

/**
 * A read-only LevelDB reader for the Slack desktop app's Local Storage (plan 067, U6, KTD7), in plain TypeScript so
 * loki needs no native module. It reads every table (.ldb, .sst) and log (.log) in a folder and keeps, for each key, the
 * newest write by sequence number, so a value overwritten or deleted since is not taken for the current one. It reads
 * a snapshot copy, never Slack's own folder, since Slack holds its lock while it runs.
 */

/** The newest write to one key: its value, or null when that write deleted it. */
export interface LevelEntry {
  key: Buffer;
  value: Buffer | null;
  seq: bigint;
}

const MAGIC = Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]);
const LOG_BLOCK = 32768;

function varint(buf: Buffer, at: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = at;
  while (i < buf.length && shift <= 63) {
    const b = buf[i] ?? 0;
    i++;
    value += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return { value, next: i };
    shift += 7;
  }
  throw new Error("leveldb: bad varint");
}

/** The entries of one block: keys share prefixes with the key before them, up to the restart array at the end. */
function blockEntries(block: Buffer): Array<{ key: Buffer; value: Buffer }> {
  if (block.length < 4) return [];
  const restarts = block.readUInt32LE(block.length - 4);
  const end = block.length - 4 - restarts * 4;
  const out: Array<{ key: Buffer; value: Buffer }> = [];
  let at = 0;
  let prev = Buffer.alloc(0);
  try {
    while (at < end) {
      const shared = varint(block, at);
      const unshared = varint(block, shared.next);
      const valueLen = varint(block, unshared.next);
      at = valueLen.next;
      if (at + unshared.value + valueLen.value > end || shared.value > prev.length) break;
      const key = Buffer.concat([prev.subarray(0, shared.value), block.subarray(at, at + unshared.value)]);
      at += unshared.value;
      out.push({ key, value: block.subarray(at, at + valueLen.value) });
      at += valueLen.value;
      prev = key;
    }
  } catch {
    // A block cut short keeps the entries read before the break.
  }
  return out;
}

/** The block a handle points at, without its five-byte trailer (kind and checksum), decompressed when it is Snappy. */
function readBlock(file: Buffer, handle: Buffer): Buffer | null {
  const offset = varint(handle, 0);
  const size = varint(handle, offset.next);
  const end = offset.value + size.value;
  if (end + 5 > file.length) return null;
  const kind = file[end];
  const raw = file.subarray(offset.value, end);
  if (kind === 0) return raw;
  if (kind === 1) return snappyUncompress(raw);
  return null;
}

/** A table's entries: each internal key is the user key and an 8-byte trailer of sequence << 8 | kind (1 a value, 0 a deletion). */
function tableEntries(file: Buffer): LevelEntry[] {
  if (file.length < 48 || !file.subarray(file.length - 8).equals(MAGIC)) return [];
  const footer = file.subarray(file.length - 48);
  let index: Buffer | null;
  try {
    const meta = varint(footer, 0);
    const metaSize = varint(footer, meta.next);
    index = readBlock(file, footer.subarray(metaSize.next));
  } catch {
    return [];
  }
  if (!index) return [];
  const out: LevelEntry[] = [];
  for (const handle of blockEntries(index)) {
    let data: Buffer | null;
    try {
      data = readBlock(file, handle.value);
    } catch {
      continue;
    }
    for (const e of data ? blockEntries(data) : []) {
      if (e.key.length < 8) continue;
      const trailer = e.key.readBigUInt64LE(e.key.length - 8);
      out.push({ key: e.key.subarray(0, e.key.length - 8), value: (trailer & 0xffn) === 1n ? e.value : null, seq: trailer >> 8n });
    }
  }
  return out;
}

/** A write batch: its first sequence number and count, then each write as kind, key and (for a value) the value. */
function batchEntries(batch: Buffer, out: LevelEntry[]): void {
  if (batch.length < 12) return;
  let seq = batch.readBigUInt64LE(0);
  let at = 12;
  try {
    while (at < batch.length) {
      const kind = batch[at];
      const key = varint(batch, at + 1);
      const keyBytes = batch.subarray(key.next, key.next + key.value);
      at = key.next + key.value;
      if (kind === 1) {
        const value = varint(batch, at);
        out.push({ key: keyBytes, value: batch.subarray(value.next, value.next + value.value), seq });
        at = value.next + value.value;
      } else if (kind === 0) out.push({ key: keyBytes, value: null, seq });
      else break;
      seq++;
    }
  } catch {
    // A batch cut short (Slack writing as the snapshot was taken) keeps the writes read before the break.
  }
}

/** A log's writes: records in 32 KiB blocks, a batch split over several records when it does not fit in one. */
function logEntries(file: Buffer): LevelEntry[] {
  const out: LevelEntry[] = [];
  let at = 0;
  let pending: Buffer[] = [];
  while (at + 7 <= file.length) {
    const room = LOG_BLOCK - (at % LOG_BLOCK);
    if (room < 7) {
      at += room;
      continue;
    }
    const length = file.readUInt16LE(at + 4);
    const type = file[at + 6];
    if (length === 0 || at + 7 + length > file.length) {
      at += room;
      pending = [];
      continue;
    }
    const data = file.subarray(at + 7, at + 7 + length);
    at += 7 + length;
    if (type === 1) batchEntries(data, out);
    else if (type === 2) pending = [data];
    else if (type === 3 && pending.length) pending.push(data);
    else if (type === 4 && pending.length) {
      batchEntries(Buffer.concat([...pending, data]), out);
      pending = [];
    }
  }
  return out;
}

/** The newest write of every key in a LevelDB folder whose key contains `part`, across its tables and logs. */
export async function readLevelDb(dir: string, part: Buffer): Promise<LevelEntry[]> {
  const files = await readdir(dir);
  const newest = new Map<string, LevelEntry>();
  for (const name of files) {
    const isTable = name.endsWith(".ldb") || name.endsWith(".sst");
    if (!isTable && !name.endsWith(".log")) continue;
    const bytes = await readFile(join(dir, name));
    for (const e of isTable ? tableEntries(bytes) : logEntries(bytes)) {
      if (!e.key.includes(part)) continue;
      const id = e.key.toString("hex");
      const known = newest.get(id);
      if (!known || e.seq > known.seq) newest.set(id, e);
    }
  }
  return [...newest.values()];
}
