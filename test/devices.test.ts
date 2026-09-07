import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "../mod/devices.ts";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describe("device store", () => {
  test("mint returns a 64-hex token and the file holds only its sha256", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-devices-"));
    try {
      const path = join(dir, "devices.json");
      const store = new DeviceStore(path);
      const { id, token } = store.mint("Deepak's iPhone");
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      expect(id).toBeTruthy();
      const raw = readFileSync(path, "utf8");
      expect(raw).not.toContain(token);
      const file = JSON.parse(raw) as Array<Record<string, unknown>>;
      expect(file).toHaveLength(1);
      expect(file[0]).toMatchObject({ id, name: "Deepak's iPhone", tokenHash: sha256(token) });
      expect(typeof file[0].createdAt).toBe("string");
      expect(typeof file[0].lastSeenAt).toBe("string");
      // list() never exposes the hash
      expect(store.list()).toEqual([{ id, name: "Deepak's iPhone", createdAt: file[0].createdAt as string, lastSeenAt: file[0].lastSeenAt as string }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("verify accepts the token, rejects a one-character change, and forget revokes", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-devices-"));
    try {
      const store = new DeviceStore(join(dir, "devices.json"));
      const { id, token } = store.mint("phone");
      expect(store.verify(token)?.id).toBe(id);
      const flipped = (token[0] === "a" ? "b" : "a") + token.slice(1);
      expect(store.verify(flipped)).toBeNull();
      expect(store.verify("")).toBeNull();
      expect(store.verify("not-hex")).toBeNull();
      expect(store.forget(id)).toBe(true);
      expect(store.forget(id)).toBe(false);
      expect(store.verify(token)).toBeNull();
      expect(store.list()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a new instance reads the file; lastSeenAt moves on verify but writes are throttled", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-devices-"));
    try {
      const path = join(dir, "devices.json");
      let now = Date.parse("2026-09-07T10:00:00Z");
      const store = new DeviceStore(path, { now: () => now });
      const a = store.mint("a");
      const b = store.mint("b");
      const again = new DeviceStore(path, { now: () => now });
      expect(again.list().map((d) => d.id).sort()).toEqual([a.id, b.id].sort());
      expect(again.verify(a.token)?.name).toBe("a");
      expect(again.verify(b.token)?.name).toBe("b");

      // 30 s later: seen, but not worth a write
      now += 30_000;
      again.verify(a.token);
      expect(JSON.parse(readFileSync(path, "utf8")).find((d: { id: string }) => d.id === a.id).lastSeenAt).toBe("2026-09-07T10:00:00.000Z");
      // 2 min later: persisted
      now += 90_000;
      again.verify(a.token);
      expect(JSON.parse(readFileSync(path, "utf8")).find((d: { id: string }) => d.id === a.id).lastSeenAt).toBe("2026-09-07T10:02:00.000Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
