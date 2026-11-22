import { describe, expect, test } from "vitest";
import { workflowCommentProblems } from "../scripts/workflow-comments.ts";

const lines = (text: string) => workflowCommentProblems(text).map((p) => p.line);

describe("comments in a workflow", () => {
  test("a pinned action's version label, a link and a listed marker stay", () => {
    expect(
      lines(
        [
          "steps:",
          "  - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0",
          "  # see https://docs.github.com/actions",
          "  # Outside (GitHub Actions): a skipped job reports as passed,",
          "  # so a required check that skips still lets a PR merge.",
          "  - run: echo done",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("a plain comment, on its own line or after a value, fails", () => {
    expect(lines(["jobs:", "  # side by side, not one after another", "  lint:", "    runs-on: ubuntu-latest # the fast one"].join("\n"))).toEqual([2, 4]);
  });

  test("an apostrophe inside a plain value does not hide a comment after it", () => {
    expect(lines(["  - name: find Node's major version # a note", "  - name: find the version # a note"].join("\n"))).toEqual([1, 2]);
  });

  test("a hash inside quotes or a word is not a comment", () => {
    expect(lines(['  - run: echo "# not a comment"', "  - run: echo ${#PATH}", "  - run: open https://x.test/page#part"].join("\n"))).toEqual([]);
  });

  test("a marker with a name not on the list fails", () => {
    expect(workflowCommentProblems("# Outside (Gremlins): they ate the cache.")[0]?.message).toContain("Gremlins");
  });
});
