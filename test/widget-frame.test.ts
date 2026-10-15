import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { BRIDGE, FRAME_PATH, WIDGET_SANDBOX, isDataPath, isJsonValue, readFrameMessage, widgetSource } from "../app/src/desk/widget-bridge.ts";
import { rewriteSharedImports } from "../app/src/frame/rewrite.ts";
import { BOOT_REPORTER, FRAME_CSP, buildFrameHtml } from "../app/src/frame/build.ts";

/**
 * Agent-written widgets run in a sandboxed iframe, never in the page (where they could read the daemon token and
 * approve their own commands). The sandbox stays opaque, the page takes only the messages it knows from the one
 * frame it made, and nothing in the frame's document carries the token.
 */

const frame = {} as Window;
const other = {} as Window;
const msg = (data: Record<string, unknown>, source: unknown = frame) => readFrameMessage({ source, data: { bridge: BRIDGE, ...data } }, frame);

describe("widget frame: the sandbox", () => {
  test("scripts only: no same-origin, no popups, no top navigation, no forms", () => {
    expect(WIDGET_SANDBOX).toBe("allow-scripts");
  });

  test("the iframe carries that sandbox, loads the frame page and never sees the token", async () => {
    const g = globalThis as unknown as { window?: unknown };
    const had = "window" in g;
    const saved = g.window;
    g.window = { __LOKI__: { token: "tok-SECRET-123", modPort: 41414 } };
    try {
      const { renderToStaticMarkup } = await import("react-dom/server");
      const { createElement } = await import("react");
      const { ModuleWidget } = await import("../app/src/desk/module-widget.tsx");
      const entry = { id: "d/w", name: "w.tsx", file: "d/w.tsx", kind: "module", title: "W", hash: "h1" } as never;
      const html = renderToStaticMarkup(createElement(ModuleWidget, { entry, overlay: undefined, gesture: () => {}, onError: () => {} }));
      expect(html).toContain(`sandbox="${WIDGET_SANDBOX}"`);
      expect(html).toContain(`src="${FRAME_PATH}"`);
      expect(html).not.toContain("srcdoc");
      expect(html).not.toContain("allow-same-origin");
      expect(html).not.toContain("SECRET");
    } finally {
      if (had) g.window = saved;
      else delete g.window;
    }
  });
});

describe("widget frame: messages from the frame", () => {
  test("only from the frame's own window", () => {
    expect(msg({ type: "ready" })).toEqual({ type: "ready" });
    expect(msg({ type: "ready" }, other)).toBeNull();
    expect(msg({ type: "ready" }, null)).toBeNull();
    expect(readFrameMessage({ source: frame, data: { bridge: BRIDGE, type: "ready" } }, null)).toBeNull();
  });

  test("only tagged, known shapes", () => {
    expect(readFrameMessage({ source: frame, data: { type: "ready" } }, frame)).toBeNull();
    expect(readFrameMessage({ source: frame, data: "ready" }, frame)).toBeNull();
    expect(readFrameMessage({ source: frame, data: null }, frame)).toBeNull();
    for (const type of ["approve", "chat_approve", "frame", "send", "gesture", "token", "", 42]) expect(msg({ type })).toBeNull();
  });

  test("set: a dot-path into the widget's data and a JSON value; the page names the widget", () => {
    expect(msg({ type: "set", path: "days", value: 3 })).toEqual({ type: "set", path: "days", value: 3 });
    expect(msg({ type: "set", path: "a.b", value: { x: [1, "y", null, true] } })).toEqual({ type: "set", path: "a.b", value: { x: [1, "y", null, true] } });
    // a widget id the frame sends is not read: the page uses its own
    expect(msg({ type: "set", id: "other/widget", path: "x", value: 1 })).toEqual({ type: "set", path: "x", value: 1 });
    expect(msg({ type: "set", path: "x" })).toBeNull();
    expect(msg({ type: "set", path: "", value: 1 })).toBeNull();
    expect(msg({ type: "set", path: 7, value: 1 })).toBeNull();
    for (const path of ["__proto__.polluted", "a.constructor.prototype", "a..b", "x".repeat(300)]) expect(msg({ type: "set", path, value: 1 })).toBeNull();
    for (const value of [new Date(), Number.NaN, Infinity, new Map(), () => 1, undefined]) expect(msg({ type: "set", path: "x", value })).toBeNull();
  });

  test("JSON values: plain, bounded", () => {
    expect(isJsonValue({ a: [1, { b: "c" }] })).toBe(true);
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(isJsonValue(deep)).toBe(false);
    expect(isJsonValue(new Array(30_000).fill(0))).toBe(false);
    expect(isJsonValue(Object.create({ inherited: 1 }))).toBe(false);
    expect(isDataPath("a.b.c")).toBe(true);
  });

  test("loaded, error, size, focus, open", () => {
    expect(msg({ type: "loaded", hash: "h", data: { a: 1 } })).toEqual({ type: "loaded", hash: "h", data: { a: 1 } });
    expect(msg({ type: "loaded", hash: "h", data: [1] })).toEqual({ type: "loaded", hash: "h", data: {} });
    expect(msg({ type: "loaded", data: {} })).toBeNull();
    expect(msg({ type: "error", hash: "h", message: "boom" })).toEqual({ type: "error", hash: "h", message: "boom" });
    expect(msg({ type: "error", hash: "h", message: { toString: () => "x" } })).toBeNull();
    expect(msg({ type: "size", width: 120.2, height: 80 })).toEqual({ type: "size", width: 121, height: 80 });
    expect(msg({ type: "size", width: 1e9, height: 80 })).toEqual({ type: "size", width: 20_000, height: 80 });
    for (const bad of [-1, Number.NaN, "100"]) expect(msg({ type: "size", width: bad, height: 80 })).toBeNull();
    expect(msg({ type: "focus" })).toEqual({ type: "focus" });
    expect(msg({ type: "open", url: "https://example.com/a" })).toEqual({ type: "open", url: "https://example.com/a" });
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "loki://localhost/x", "not a url", 5]) expect(msg({ type: "open", url })).toBeNull();
  });
});

describe("widget frame: where the module comes from", () => {
  test("the shell's loki scheme, spelled per webview", () => {
    expect(widgetSource("trip/budget.tsx", "abc", { tauri: true, os: "macos", dev: false })).toEqual({ url: "loki://localhost/widgets/trip/budget.js?v=abc" });
    expect(widgetSource("trip/budget.jsx", "abc", { tauri: true, os: "linux", dev: true })).toEqual({ url: "loki://localhost/widgets/trip/budget.js?v=abc" });
    expect(widgetSource("trip/budget.tsx", "abc", { tauri: true, os: "windows", dev: false })).toEqual({
      url: "http://loki.localhost/widgets/trip/budget.js?v=abc",
    });
  });
  test("the Vite tab fetches it from the dev server; a built page without the shell has none", () => {
    // the dev server's route takes the .js name, as widgets.rs does (a .tsx name was a 404 there)
    expect(widgetSource("trip/my widget.tsx", "a b", { tauri: false, os: "macos", dev: true })).toEqual({ fetch: "/@loki-widget/trip/my%20widget.js?v=a%20b" });
    expect(widgetSource("trip/chart.jsx", "abc", { tauri: false, os: "macos", dev: true })).toEqual({ fetch: "/@loki-widget/trip/chart.js?v=abc" });
    expect(widgetSource("trip/budget.tsx", "abc", { tauri: false, os: "macos", dev: false })).toBeNull();
  });
});

describe("widget frame: shared imports (the Vite tab's widgets.rs)", () => {
  test("the same rewrites as the Rust core", () => {
    const code =
      'import React, { useState, useEffect as ue } from "react";\nimport * as K from "@loki/kit";\nimport { jsx as _jsx } from "react/jsx-runtime";\nimport x from "./local.js";\n';
    const out = rewriteSharedImports(code);
    expect(out).toContain('const React = window.__lokiShared["react"].default ?? window.__lokiShared["react"];');
    expect(out).toContain('const { useState, useEffect: ue } = window.__lokiShared["react"];');
    expect(out).toContain('const K = window.__lokiShared["@loki/kit"];');
    expect(out).toContain('const { jsx: _jsx } = window.__lokiShared["react/jsx-runtime"];');
    expect(out).toContain('import x from "./local.js";');
  });
});

describe("widget frame: the document", () => {
  test("no network from inside the frame, scripts only inline or from the shell's scheme", () => {
    const directives = Object.fromEntries(FRAME_CSP.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));
    expect(directives["connect-src"]).toEqual(["'none'"]);
    expect(directives["default-src"]).toEqual(["'none'"]);
    expect(directives["frame-src"]).toEqual(["'none'"]);
    expect(directives["script-src"]).not.toContain("'self'");
    expect(directives["script-src"].some((s: string) => s.startsWith("http://127") || s === "https:" || s === "*")).toBe(false);
  });

  test("the built frame carries its policy and nothing of the token", async () => {
    const html = await buildFrameHtml(true);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`);
    // two scripts, the boot reporter then the runtime, and no stray </script> cutting the runtime short
    expect(html.match(/<\/script>/g)?.length).toBe(2);
    expect(html.indexOf(BOOT_REPORTER)).toBeGreaterThan(-1);
    expect(html.indexOf(BOOT_REPORTER)).toBeLessThan(html.lastIndexOf("<script>"));
    expect(html).not.toContain("loki.token");
    expect(html).not.toContain("localStorage");
    expect(html).not.toMatch(/__LOKI__\s*\??\.\s*token/);
    expect(html).not.toContain("/ws?t=");
  }, 30_000);
});

describe("widget frame: the shell's CSP", () => {
  const { csp, devCsp } = (
    JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")) as { app: { security: { csp: string; devCsp: string } } }
  ).app.security;
  const directive = (policy: string, name: string) =>
    policy
      .split(";")
      .map((d: string) => d.trim().split(/\s+/))
      .find((d: string[]) => d[0] === name)
      ?.slice(1) ?? [];
  test("frames only the widget frame, on both spellings of the app's origin", () => {
    expect(directive(csp, "frame-src")).toEqual(["tauri://localhost/widget-frame.html", "http://tauri.localhost/widget-frame.html"]);
    expect(directive(devCsp, "frame-src")).toEqual(["http://127.0.0.1:5173/widget-frame.html"]);
  });
  test("widget modules load from the loki scheme on every webview", () => {
    for (const p of [csp, devCsp]) expect(directive(p, "script-src")).toEqual(expect.arrayContaining(["loki:", "http://loki.localhost"]));
  });
});
