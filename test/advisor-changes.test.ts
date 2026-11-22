import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { changesConsultText, consultTextOf } from "../daemon/advisor-changes.ts";

const folder = join("/", "work", "site");

describe("the consult /advisor alone sends", () => {
  test("uncommitted changes list each file with its stats, and how many more there are", () => {
    const files = [
      { path: "a.ts", added: 3, deleted: 1 },
      { path: "new.ts", added: null, deleted: null },
    ];
    expect(consultTextOf(folder, { kind: "uncommitted", files, more: 50 })).toEqual({
      text: [`Review the uncommitted changes in ${folder}:`, "- a.ts (+3 -1)", "- new.ts", "- and 50 more"].join("\n"),
    });
  });

  test("with nothing uncommitted, the branch's commits not on its upstream and the files they change", () => {
    const list = {
      kind: "unpushed" as const,
      upstream: "origin/main",
      commits: [
        { hash: "abc1234", subject: "fix the parser" },
        { hash: "def5678", subject: "add a test" },
      ],
      files: [{ path: "src/parse.ts", added: 5, deleted: 2 }],
      more: 0,
    };
    expect(consultTextOf(folder, list)).toEqual({
      text: [
        `Review the commits in ${folder} not yet on origin/main:`,
        "- abc1234 fix the parser",
        "- def5678 add a test",
        "",
        "The files they change:",
        "- src/parse.ts (+5 -2)",
      ].join("\n"),
    });
  });

  test("no folder, no checkout and nothing changed each give a notice that there is nothing to review, and no text", async () => {
    expect(await changesConsultText(undefined)).toEqual({ notice: "Nothing to review: this chat has no folder." });
    expect(consultTextOf(folder, { kind: "not_a_checkout" })).toEqual({ notice: `Nothing to review: ${folder} is not a git checkout.` });
    expect(consultTextOf(folder, { kind: "nothing_changed" })).toEqual({
      notice: `Nothing to review: ${folder} has no uncommitted changes and no commits that are not on its upstream.`,
    });
  });
});
