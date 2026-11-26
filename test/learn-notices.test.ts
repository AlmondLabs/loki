import { describe, expect, test, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Learn as LearnModel } from "../app/src/shell/use-learn.ts";

vi.hoisted(() => {
  Object.assign(globalThis, { sessionStorage: { getItem: () => "leads", setItem: () => {} } });
});
// Outside (React): a static render does not draw portals, so the columns, which reach the shell's slots through
// portals, draw in place.
vi.mock("../app/src/shell/place-columns.tsx", async () => {
  const { createElement, Fragment } = await import("react");
  return { PlaceColumns: ({ list, detail }: { list: ReactNode; detail: ReactNode }) => createElement(Fragment, null, list, detail) };
});
const { Learn } = await import("../app/src/learn/learn.tsx");

describe("Learn's notices", () => {
  test("with no snapshot (the mod did not answer), a list view's detail says the error once", () => {
    const recall = { snap: null, error: "learn did not answer", due: 0, starting: null } as unknown as LearnModel;
    const out = renderToStaticMarkup(createElement(Learn, { recall, active: false, onOpenChat: () => {}, onBegin: () => {} }));
    expect(out).toContain("Leads");
    expect(out.split("learn did not answer").length - 1).toBe(1);
  });
});
