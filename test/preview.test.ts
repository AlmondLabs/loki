import { describe, expect, test } from "vitest";
import { previewLine } from "../app/src/shared/preview.ts";

describe("a message as a preview line", () => {
  test("markdown's marks come out; the words stay", () => {
    expect(previewLine("Use **Next** to step through writing, storing and reading a bit.")).toBe("Use Next to step through writing, storing and reading a bit.");
    expect(previewLine("## Plan\nmore")).toBe("Plan");
    expect(previewLine("- a `git fetch` then _merge_ [the PR](https://x.y/1)")).toBe("a git fetch then merge the PR");
    expect(previewLine("\n\n> quoted ~~old~~ new")).toBe("quoted old new");
  });
  test("what is not markdown is left alone: snake_case, a lone star, arithmetic", () => {
    expect(previewLine("set desk_state and widget_log")).toBe("set desk_state and widget_log");
    expect(previewLine("2 * 3 = 6")).toBe("2 * 3 = 6");
    expect(previewLine("")).toBeNull();
    expect(previewLine(null)).toBeNull();
  });
});
