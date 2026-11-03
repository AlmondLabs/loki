import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, writeFileAtomic, writeJsonAtomic } from "../mod/json-file.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "loki-json-file-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the files loki keeps", () => {
  test("a missing file or one that is not JSON reads as null", () => {
    expect(readJson(join(dir, "nope.json"))).toBeNull();
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    expect(readJson(bad)).toBeNull();
  });

  test("JSON is written on one line unless asked to be indented and end with a newline", () => {
    const file = join(dir, "a", "b", "plain.json");
    writeJsonAtomic(file, { a: 1, b: [2] });
    expect(readFileSync(file, "utf8")).toBe('{"a":1,"b":[2]}');
    writeJsonAtomic(file, { a: 1 }, { pretty: true });
    expect(readFileSync(file, "utf8")).toBe('{\n  "a": 1\n}');
    writeJsonAtomic(file, { a: 1 }, { pretty: true, newline: true });
    expect(readFileSync(file, "utf8")).toBe('{\n  "a": 1\n}\n');
    expect(readJson(file)).toEqual({ a: 1 });
  });

  test("nothing is left beside the file, with the process's id in the name or without", () => {
    const sub = join(dir, "clean");
    writeJsonAtomic(join(sub, "one.json"), [1]);
    writeJsonAtomic(join(sub, "two.json"), [2], { pidTemp: true });
    writeFileAtomic(join(sub, "three.bin"), Buffer.from([1, 2, 3]));
    expect(readdirSync(sub).sort()).toEqual(["one.json", "three.bin", "two.json"]);
    expect([...readFileSync(join(sub, "three.bin"))]).toEqual([1, 2, 3]);
    expect(existsSync(join(sub, "two.json.tmp"))).toBe(false);
  });

  test.skipIf(process.platform === "win32")("a file that holds secrets is readable by its owner alone", () => {
    const file = join(dir, "secret.json");
    writeJsonAtomic(file, { token: "t" }, { mode: 0o600, pidTemp: true });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
