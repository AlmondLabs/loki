import { afterEach, describe, expect, test } from "vitest";
import { threadPreview } from "../app/src/item/preview.ts";

// Plan 096, U4: the new thread is a per-Mac preference, off unless chosen. Node has no localStorage, so these also
// prove the value holds for the window when storage is unavailable.
describe("new chat pane (preview)", () => {
  afterEach(() => threadPreview.set("off"));

  test("is off until chosen", () => {
    expect(threadPreview.get()).toBe("off");
  });

  test("turns on and off, and tells its readers", () => {
    const seen: string[] = [];
    const stop = threadPreview.subscribe(() => seen.push(threadPreview.get()));
    threadPreview.set("on");
    threadPreview.set("on");
    threadPreview.set("off");
    stop();
    expect(seen).toEqual(["on", "off"]);
  });
});
