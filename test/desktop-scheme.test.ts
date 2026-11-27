import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { appFile, contentType, inlineScriptHashes, pageCsp } from "../desktop/scheme.ts";

const sha = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

describe("the files loki://app serves", () => {
  test("a path under the page's folder maps to its file, and the root to index.html", () => {
    expect(appFile("/assets/index-1.js")).toBe("assets/index-1.js");
    expect(appFile("/")).toBe("index.html");
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

  test("the policy names loki's own scheme and the daemon's loopback, and nothing of Tauri's", () => {
    const csp = pageCsp(["'sha256-abc'"]);
    expect(csp).toContain("script-src 'self' 'sha256-abc'");
    expect(csp).toContain("connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* https: wss:");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/tauri|ipc:/);
  });
});
