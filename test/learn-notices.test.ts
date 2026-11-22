import { describe, expect, test, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Recall as RecallModel } from "../app/src/shell/use-recall.ts";

vi.hoisted(() => {
  Object.assign(globalThis, { sessionStorage: { getItem: () => "leads", setItem: () => {} } });
});
// Outside (React): a static render does not draw portals, so the columns, which reach the shell's slots through
// portals, draw in place.
vi.mock("../app/src/shell/place-columns.tsx", async () => {
  const { createElement, Fragment } = await import("react");
  return { PlaceColumns: ({ list, detail }: { list: ReactNode; detail: ReactNode }) => createElement(Fragment, null, list, detail) };
});
const { Recall } = await import("../app/src/recall/recall.tsx");

describe("Learn's notices", () => {
  test("with no snapshot (the mod did not answer), a list view's detail says the error once", () => {
    const recall = { snap: null, error: "recall did not answer", due: 0, starting: null } as unknown as RecallModel;
    const out = renderToStaticMarkup(createElement(Recall, { recall, active: false, onOpenDesk: () => {}, onBegin: () => {} }));
    expect(out).toContain("Leads");
    expect(out.split("recall did not answer").length - 1).toBe(1);
  });
});
