import { describe, expect, test } from "vitest";
import { needsAppBuild, runGraph, verifyGraph } from "../scripts/verify.ts";

describe("local verification runner", () => {
  test("needsAppBuild skips rebuilding app/dist only when dist already exists and neither app nor core changed", () => {
    expect(needsAppBuild(["daemon/acp/chats.ts"], true)).toBe(false);
    expect(needsAppBuild(["daemon/acp/chats.ts"], false)).toBe(true);
    expect(needsAppBuild(["app/src/app.tsx"], true)).toBe(true);
    expect(needsAppBuild(["core/harness.ts"], true)).toBe(true);
    expect(needsAppBuild(["package.json"], true)).toBe(true);
  });

  test("verifyGraph runs ready tasks in parallel and sequences heavy test/build waves cleanly", () => {
    const full = verifyGraph({ pr: false, buildApp: true });
    expect(full.find((t) => t.id === "lint")?.command).toEqual(["bun", "run", "lint"]);
    expect(full.find((t) => t.id === "test")?.after).toEqual(["lint", "typecheck", "build:app"]);
    expect(full.find((t) => t.id === "test:node")?.after).toEqual(["test"]);
    expect(full.find((t) => t.id === "build:app")?.after).toEqual(["typecheck"]);
    expect(full.find((t) => t.id === "build:mod")?.after).toEqual(["build:app"]);
    expect(full.find((t) => t.id === "smoke")?.after).toEqual(["build:mod"]);

    const pr = verifyGraph({ pr: true, base: "abc123", buildApp: false });
    expect(pr.find((t) => t.id === "lint")?.command).toEqual(["bun", "run", "lint:pr", "abc123"]);
    expect(pr.find((t) => t.id === "test")?.command).toEqual(["bun", "run", "test:pr", "abc123"]);
    expect(pr.find((t) => t.id === "test")?.after).toEqual(["lint", "typecheck"]);
    expect(pr.some((t) => t.id === "build:app")).toBe(false);
    expect(pr.find((t) => t.id === "build:mod")?.after).toBeUndefined();
    expect(pr.find((t) => t.id === "smoke")?.after).toEqual(["build:mod"]);
  });

  test("runGraph runs ready tasks in parallel and skips downstream dependents when an upstream step fails", async () => {
    const order: string[] = [];
    const { ok, results } = await runGraph(verifyGraph({ pr: false, buildApp: true }), async (task) => {
      order.push(`start:${task.id}`);
      await Promise.resolve();
      order.push(`end:${task.id}`);
      return { code: task.id === "build:app" ? 1 : 0, output: task.id === "build:app" ? "vite error" : "ok", ms: 5 };
    });
    expect(ok).toBe(false);
    expect(order.indexOf("start:lint")).toBeLessThan(order.indexOf("end:format"));
    expect(results.find((r) => r.id === "build:app")?.code).toBe(1);
    expect(results.find((r) => r.id === "build:mod")?.skipped).toBe(true);
    expect(results.find((r) => r.id === "smoke")?.skipped).toBe(true);
  });
});
