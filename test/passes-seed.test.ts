import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassState } from "../daemon/passes-state.ts";

const dirs: string[] = [];

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loki-passes-seed-"));
  dirs.push(dir);
  return dir;
}

const cursorsIn = (dir: string) => JSON.parse(readFileSync(join(dir, "pass-cursors.json"), "utf8")) as { cursors: Record<string, Record<string, number>> };

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("background passes start each chat from where it is", () => {
  test("with no cursors saved yet, every chat starts at its current length for every pass", () => {
    const dir = stateDir();
    new PassState(dir).seed([
      { agentId: "a1", chatId: "c1", entries: 10 },
      { agentId: "a1", chatId: "c2", entries: 0 },
    ]);
    const { cursors } = cursorsIn(dir);
    expect(cursors.reflection).toEqual({ "a1/c1": 10, "a1/c2": 0 });
    expect(cursors.learn).toEqual({ "a1/c1": 10, "a1/c2": 0 });
  });

  test("saved cursors are left as they are", () => {
    const dir = stateDir();
    writeFileSync(join(dir, "pass-cursors.json"), JSON.stringify({ cursors: { reflection: { "a1/c1": 4 }, learn: {} }, learn_written: { day: "", count: 0 } }));
    new PassState(dir).seed([{ agentId: "a1", chatId: "c1", entries: 10 }]);
    expect(cursorsIn(dir).cursors.reflection).toEqual({ "a1/c1": 4 });
  });

  test("with nothing saved, the settings are the defaults", () => {
    expect(new PassState(stateDir()).settings()).toEqual({
      reflection: { enabled: true },
      learn: { enabled: false, daily_cap: 5 },
      acp: { enabled: true },
    });
  });
});
