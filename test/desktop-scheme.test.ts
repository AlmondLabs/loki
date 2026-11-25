import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { appFile, contentType, inlineScriptHashes, pageCsp, serveWidget } from "../desktop/scheme.ts";

const sha = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

describe("the files loki://app serves", () => {
  test("a path under the page's folder maps to its file, and the root to index.html", () => {
    expect(appFile("/assets/index-1.js")).toBe("assets/index-1.js");
    expect(appFile("/")).toBe("index.html");
    expect(appFile("/widget-frame.html")).toBe("widget-frame.html");
    expect(appFile("/a%20b.png")).toBe("a b.png");
  });

  test("no path leaves the folder: .., an encoded .., a backslash or a drive", () => {
    expect(appFile("/../token")).toBeNull();
    expect(appFile("/assets/%2e%2e/%2e%2e/token")).toBeNull();
    expect(appFile("/a\\b.js")).toBeNull();
    expect(appFile("/C:/x")).toBeNull();
    expect(appFile("/%E0%A4%A")).toBeNull();
  });

  test("each file goes out with its type", () => {
    expect(contentType("index.html")).toBe("text/html; charset=utf-8");
    expect(contentType("a.js")).toBe("text/javascript; charset=utf-8");
    expect(contentType("a.css")).toBe("text/css; charset=utf-8");
    expect(contentType("a.svg")).toBe("image/svg+xml");
    expect(contentType("manifest.webmanifest")).toBe("application/manifest+json");
    expect(contentType("a.bin")).toBe("application/octet-stream");
  });
});

describe("the page's content security policy", () => {
  test("an inline script runs only as the hash of its own text; a script with a source is not hashed", () => {
    const html = `<html><head><script>var a = 1;</script><script type="module" src="/x.js"></script><script>\n  b();\n</script></head></html>`;
    expect(inlineScriptHashes(html)).toEqual([sha("var a = 1;"), sha("\n  b();\n")]);
  });

  test("the policy names loki's own scheme, the daemon's loopback and the widget frame, and nothing of Tauri's", () => {
    const csp = pageCsp(["'sha256-abc'"]);
    expect(csp).toContain("script-src 'self' 'sha256-abc'");
    expect(csp).toContain("connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* https: wss:");
    expect(csp).toContain("frame-src loki://app/widget-frame.html");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/tauri|ipc:/);
  });
});

describe("module widgets from loki://app/widgets", () => {
  const made: string[] = [];
  const widgets = () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-widgets-"));
    made.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const get = (dir: string, path: string) => serveWidget(dir, new URL(`loki://app${path}`));

  test("a widget's .tsx is compiled with the automatic JSX runtime and its shared imports read from the frame", async () => {
    const dir = widgets();
    mkdirSync(join(dir, "desk"));
    writeFileSync(
      join(dir, "desk", "chart.tsx"),
      'import { useState } from "react";\nexport default function C() { const [n] = useState(1); return <b>{n}</b>; }\n',
    );
    const r = await get(dir, "/widgets/desk/chart.js?v=1");
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    const code = await r.text();
    expect(code).toContain('window.__lokiShared["react"]');
    expect(code).toContain('window.__lokiShared["react/jsx-runtime"]');
  });

  test("a widget that does not compile answers a module that throws its file and message", async () => {
    const dir = widgets();
    writeFileSync(join(dir, "broken.tsx"), "export default function ( {");
    const code = await (await get(dir, "/widgets/broken.js")).text();
    expect(code).toMatch(/^throw new Error\(".*broken\.tsx: /);
  });

  test("no widget path leaves the folder, and a missing widget is not found", async () => {
    const dir = widgets();
    expect((await get(dir, "/widgets/../token.js")).status).toBe(404);
    expect((await get(dir, "/widgets/%2e%2e/x.js")).status).toBe(404);
    expect((await get(dir, "/widgets/a%5Cb.js")).status).toBe(404);
    expect((await get(dir, "/widgets/none.js")).status).toBe(404);
  });
});
