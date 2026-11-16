import { describe, expect, test } from "vitest";
import { cn } from "../app/src/lib/utils.ts";

describe("cn", () => {
  test("type sizes and colours both stay", () => {
    expect(cn("bg-primary text-primary-foreground", "text-sm")).toBe("bg-primary text-primary-foreground text-sm");
    expect(cn("text-xs", "text-loki-positive")).toBe("text-xs text-loki-positive");
  });

  test("a later size still wins over an earlier one, and a later colour over an earlier colour", () => {
    expect(cn("text-sm", "text-xs")).toBe("text-xs");
    expect(cn("text-muted-foreground", "text-foreground")).toBe("text-foreground");
  });

  test("loki's shadows are shadows, not shadow colours", () => {
    expect(cn("shadow-low", "shadow-float")).toBe("shadow-float");
  });
});
