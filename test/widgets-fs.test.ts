import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkModule, parseJsonWidget, scanWidgets, titleFromModule, watchWidgets, type WidgetsDiff } from "../mod/widgets-fs.ts";

describe("parseJsonWidget", () => {
  test("valid kit widget", () => {
    const p = parseJsonWidget('{"type":"stat","title":"Sleep","data":{"value":7}}');
    expect(p).toEqual({ type: "stat", title: "Sleep", data: { value: 7 } });
  });
  test("errors are specific", () => {
    expect(parseJsonWidget("{").error).toMatch(/invalid JSON/);
    expect(parseJsonWidget("[]").error).toMatch(/object/);
    expect(parseJsonWidget('{"title":"x"}').error).toMatch(/missing "type"/);
    expect(parseJsonWidget('{"type":"nope","title":"x"}').error).toMatch(/unknown type/);
    expect(parseJsonWidget('{"type":"stat"}').error).toMatch(/missing "title"/);
  });
});

describe("modules", () => {
  test("titleFromModule", () => {
    expect(titleFromModule('export const title = "Trip map";\nexport default () => null')).toBe("Trip map");
    expect(titleFromModule("export default () => null")).toBeNull();
  });
  test("checkModule: ok / syntax error / no default export", async () => {
    expect(await checkModule("export default function W() { return <div/> }", "a.tsx")).toBeNull();
    const err = await checkModule("export default function W() { return <div> }", "a.tsx");
    expect(err).toMatch(/a\.tsx:1:\d+/);
    expect(await checkModule("export const x = 1", "b.tsx")).toMatch(/default export/);
  });
});

describe("scan + watch", () => {
  test("scan builds ids as <scope>/<name>; watcher diffs add/change/remove", async () => {
    const root = mkdtempSync(join(tmpdir(), "loci-widgets-"));
    try {
      mkdirSync(join(root, "shared"));
      writeFileSync(join(root, "shared", "welcome.json"), '{"type":"info-card","title":"hi","data":{"lines":["a"]}}');
      writeFileSync(join(root, "shared", ".hidden.json"), "{}");
      writeFileSync(join(root, "shared", "notes.txt"), "ignored");
      const scanned = await scanWidgets(root);
      expect([...scanned.keys()]).toEqual(["shared/welcome"]);
      expect(scanned.get("shared/welcome")!.title).toBe("hi");

      const diffs: WidgetsDiff[] = [];
      const w = watchWidgets(root, (d) => diffs.push(d), { debounceMs: 20 });
      await w.rescan();
      expect(diffs.length).toBe(1);
      expect(diffs[0].added.map((e) => e.id)).toEqual(["shared/welcome"]);

      mkdirSync(join(root, "conv1"));
      writeFileSync(join(root, "conv1", "trip.tsx"), 'export const title = "Trip";\nexport default function T() { return <b/> }');
      writeFileSync(join(root, "shared", "welcome.json"), '{"type":"info-card","title":"hello","data":{"lines":[]}}');
      await w.rescan();
      const d = diffs[1];
      expect(d.added.map((e) => e.id)).toEqual(["conv1/trip"]);
      expect(d.added[0].title).toBe("Trip");
      expect(d.added[0].kind).toBe("module");
      expect(d.changed.map((e) => e.id)).toEqual(["shared/welcome"]);

      // runtime error merges into entries and clears when the file changes
      expect(w.setRuntimeError("conv1/trip", "boom")).toBe(true);
      expect(w.get("conv1/trip")!.error).toBe("boom");
      writeFileSync(join(root, "conv1", "trip.tsx"), 'export default function T() { return <i/> }');
      await w.rescan();
      expect(w.get("conv1/trip")!.error).toBeUndefined();
      expect(w.get("conv1/trip")!.title).toBe("trip");

      rmSync(join(root, "conv1"), { recursive: true });
      await w.rescan();
      expect(diffs[diffs.length - 1].removed).toEqual(["conv1/trip"]);
      expect(w.entries("conv1")).toEqual([]);
      w.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a broken module carries its error in the manifest", async () => {
    const root = mkdtempSync(join(tmpdir(), "loci-widgets-"));
    try {
      mkdirSync(join(root, "d"));
      writeFileSync(join(root, "d", "bad.tsx"), "export default function B() { return <div> }");
      const scanned = await scanWidgets(root);
      expect(scanned.get("d/bad")!.error).toMatch(/d\/bad\.tsx:1/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
