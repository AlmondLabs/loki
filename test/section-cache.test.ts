import { describe, expect, test } from "vitest";
import { serial } from "../daemon/repo-queue.ts";
import { SECTION_TTL_MS, SectionCache, sections } from "../daemon/section-cache.ts";

describe("prompt sections kept between model calls (plan 047)", () => {
  test("a section is rendered once within its time, and again after it", () => {
    let now = 0;
    let renders = 0;
    const cache = new SectionCache(() => now);
    const render = () => `text ${++renders}`;
    expect(cache.get("memory", render)).toBe("text 1");
    now = SECTION_TTL_MS - 1;
    expect(cache.get("memory", render)).toBe("text 1");
    expect(cache.get("skills", render)).toBe("text 2");
    now = SECTION_TTL_MS;
    expect(cache.get("memory", render)).toBe("text 3");
  });

  test("an empty section is kept too, so an agent with no memory is not read every call", () => {
    let renders = 0;
    const cache = new SectionCache(() => 0);
    const render = () => {
      renders++;
      return undefined;
    };
    cache.get("memory", render);
    cache.get("memory", render);
    expect(renders).toBe(1);
  });

  test("a commit to a memory repo clears the daemon's sections at once", async () => {
    let renders = 0;
    const render = () => `text ${++renders}`;
    sections.get("memory\u0000/tmp/agent", render);
    await serial("/tmp/agent", () => Promise.resolve());
    await Promise.resolve(); // the queue tells its listeners once the sequence has settled
    expect(sections.get("memory\u0000/tmp/agent", render)).toBe("text 2");
  });
});
