import { describe, expect, test } from "vitest";
import { watchPageBuild } from "../desktop/page-reload.ts";

function fakes() {
  let listener: ((event: string, name: string | null) => void) | null = null;
  const pending: Array<() => void> = [];
  let reloads = 0;
  return {
    watch: (_dir: string, fn: (event: string, name: string | null) => void) => {
      listener = fn;
      return { close: () => {} };
    },
    later: (fn: () => void) => {
      pending.push(fn);
      return () => {
        const i = pending.indexOf(fn);
        if (i >= 0) pending.splice(i, 1);
      };
    },
    change: (name: string | null) => listener?.("rename", name),
    flush: () => pending.splice(0).forEach((fn) => fn()),
    reload: () => reloads++,
    reloads: () => reloads,
  };
}

describe("reloading the window when update rebuilds the page", () => {
  test("app/dist taking its new build's place reloads the page windows once, however many events the swap sends", () => {
    const f = fakes();
    watchPageBuild("/app", "dist", f.reload, { watch: f.watch, later: f.later });
    f.change("dist");
    f.change("dist");
    f.flush();
    expect(f.reloads()).toBe(1);
  });

  test("the build's own folders changing reload nothing", () => {
    const f = fakes();
    watchPageBuild("/app", "dist", f.reload, { watch: f.watch, later: f.later });
    f.change(".dist-next");
    f.change(".dist-old");
    f.change(null);
    f.flush();
    expect(f.reloads()).toBe(0);
  });
});
