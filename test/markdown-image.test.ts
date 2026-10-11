import { describe, expect, test } from "vitest";
import { isRemoteImage } from "../app/src/chat/markdownImage.tsx";

/** A remote image in markdown loads only when asked: its address is how a led-astray agent would leak (markdownImage.tsx). */
describe("markdown images", () => {
  const app = "tauri://localhost/index.html";
  test("another host's image waits to be asked for", () => {
    expect(isRemoteImage("https://evil.example/p.png?secret=1", app)).toBe(true);
    expect(isRemoteImage("http://example.com/a.gif", app)).toBe(true);
    expect(isRemoteImage("//cdn.example/a.png", "http://127.0.0.1:5173/")).toBe(true);
  });
  test("data:, the page's own and the loopback daemon's show at once", () => {
    expect(isRemoteImage("data:image/png;base64,AAAA", app)).toBe(false);
    expect(isRemoteImage("http://127.0.0.1:41414/uploads/c/a.png", app)).toBe(false);
    expect(isRemoteImage("http://localhost:41414/x.png", app)).toBe(false);
    expect(isRemoteImage("/assets/logo.png", "http://192.168.1.4:41415/")).toBe(false);
    expect(isRemoteImage("http://192.168.1.4:41415/uploads/a.png", "http://192.168.1.4:41415/")).toBe(false);
    expect(isRemoteImage("not a url at all", app)).toBe(false);
  });
});
