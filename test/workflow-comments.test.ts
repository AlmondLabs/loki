import { describe, expect, test } from "vitest";
import { workflowCommentProblems } from "../scripts/workflow-comments.ts";

const lines = (text: string) => workflowCommentProblems(text).map((p) => p.line);

describe("comments in a workflow", () => {
  test("ordinary explanatory comments, pinned versions, and URLs are allowed", () => {
    expect(
      lines(
        [
          "steps:",
          "  - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0",
          "  # Run jobs side by side rather than sequentially",
          "  # see https://docs.github.com/actions",
          "  - run: echo done",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("TODO and FIXME comments fail", () => {
    expect(lines(["jobs:", "  # TODO: speed this up", "  lint:", "    runs-on: ubuntu-latest # FIXME: pin image"].join("\n"))).toEqual([2, 4]);
  });

  test("a hash inside quotes or a word is not a comment", () => {
    expect(lines(['  - run: echo "# TODO not a comment"', "  - run: echo ${#PATH}", "  - run: open https://x.test/page#part"].join("\n"))).toEqual([]);
  });
});
