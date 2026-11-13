import { describe, expect, test } from "vitest";
import { isReadOnlyCommand } from "../daemon/read-only-command.ts";

describe("a shell command that only reads (plan 094, KTD2)", () => {
  test("listing, finding, searching and reading files, alone or piped, are reads", () => {
    for (const command of [
      "ls",
      "ls -la src/",
      "find . -name '*.ts' -not -path './node_modules/*'",
      "rg -n 'a;b' daemon",
      'grep -rn "x | y" .',
      "cat README.md | head -20",
      "rg --files | wc -l",
      "tail -n 50 log.txt",
      "pwd",
      "  ls  ",
    ])
      expect(isReadOnlyCommand(command), command).toBe(true);
  });

  test("anything that could write, run another program or do more than its words say is a command", () => {
    for (const command of [
      "",
      "rm -rf x",
      "ls; rm x",
      "ls && rm x",
      "ls || rm x",
      "ls | sh",
      "cat a > b",
      "cat < a",
      "ls $(rm x)",
      "ls `rm x`",
      'echo "$HOME"',
      'grep "$(rm x)" .',
      "ls \; rm",
      "ls &",
      "(ls)",
      "find . -exec rm {} +",
      "find . -delete",
      "find . -fprint out.txt",
      "rg --pre ./run.sh x",
      "rg --pre=./run.sh x",
      "FOO=1 ls",
      "/bin/ls",
      "ls 'unclosed",
      "ls |",
      "ls\nrm x",
      "git status",
    ])
      expect(isReadOnlyCommand(command), command).toBe(false);
    expect(isReadOnlyCommand(undefined)).toBe(false);
  });
});
