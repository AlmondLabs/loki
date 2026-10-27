import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPage, isPageSource, pageStale, type Runner } from "../daemon/page-build.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A checkout with a page source, a core source and, when `built`, a build of the page. */
function checkout(built: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "loki-page-build-"));
  roots.push(root);
  mkdirSync(join(root, "app", "src"), { recursive: true });
  mkdirSync(join(root, "core"), { recursive: true });
  writeFileSync(join(root, "app", "src", "main.tsx"), "export {};");
  writeFileSync(join(root, "core", "frames.ts"), "export {};");
  if (built) {
    mkdirSync(join(root, "app", "dist"), { recursive: true });
    writeFileSync(join(root, "app", "dist", "index.html"), "old");
  }
  return root;
}

/** A build that writes `html` as the --outDir's index.html, or fails with `output`. */
function runner(html: string | null, output = ""): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = (_cmd, args) => {
    calls.push(args);
    const out = args[args.indexOf("--outDir") + 1] ?? "";
    if (html === null) return Promise.resolve({ code: 1, output });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "index.html"), html);
    return Promise.resolve({ code: 0, output: "" });
  };
  return { run, calls };
}

/** Set a file's change time, in seconds since the epoch. */
const touch = (path: string, at: number) => utimesSync(path, at, at);

describe("the built page in a checkout (plan 041)", () => {
  test("a build lands whole in app/dist, written beside it first", async () => {
    const root = checkout(true);
    const { run, calls } = runner("new");
    expect(await buildPage(root, run, "node")).toBeNull();
    expect(readFileSync(join(root, "app", "dist", "index.html"), "utf8")).toBe("new");
    expect(calls[0]).toContain(join(root, "app", ".dist-next"));
    expect(existsSync(join(root, "app", ".dist-next"))).toBe(false);
    expect(existsSync(join(root, "app", ".dist-old"))).toBe(false);
  });

  test("a failed build leaves app/dist as it was and says what failed", async () => {
    const root = checkout(true);
    const { run } = runner(null, "vite v7\nerror during build:\napp/src/x.tsx: Unexpected token");
    expect(await buildPage(root, run, "node")).toContain("app/src/x.tsx: Unexpected token");
    expect(readFileSync(join(root, "app", "dist", "index.html"), "utf8")).toBe("old");
    expect(existsSync(join(root, "app", ".dist-next"))).toBe(false);
  });

  test("a first build has no app/dist to set aside", async () => {
    const root = checkout(false);
    expect(await buildPage(root, runner("first").run, "node")).toBeNull();
    expect(readFileSync(join(root, "app", "dist", "index.html"), "utf8")).toBe("first");
  });

  test("stale when app/dist is missing, or older than a source in app/ or core/", () => {
    expect(pageStale(checkout(false))).toBe(true);
    const root = checkout(true);
    touch(join(root, "app", "src", "main.tsx"), 1_000);
    touch(join(root, "core", "frames.ts"), 1_000);
    touch(join(root, "app", "dist", "index.html"), 2_000);
    expect(pageStale(root)).toBe(false);
    touch(join(root, "core", "frames.ts"), 3_000);
    expect(pageStale(root)).toBe(true);
  });

  test("the builds and hidden files are not sources", () => {
    expect(isPageSource(join("src", "shell", "shell.tsx"))).toBe(true);
    expect(isPageSource("index.html")).toBe(true);
    expect(isPageSource(join("dist", "index.html"))).toBe(false);
    expect(isPageSource(join(".dist-next", "assets", "a.js"))).toBe(false);
    expect(isPageSource(join("src", ".shell.tsx.swp"))).toBe(false);
  });
});
