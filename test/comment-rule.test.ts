import { describe, expect, test } from "vitest";
import { ESLint, RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { commentsRule } from "../eslint-comments.mjs";

RuleTester.describe = describe;
RuleTester.it = test;
RuleTester.itOnly = test.only;

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });
const inside = (comment: string) => `export const x = 1;\n${comment}\nexport const y = 2;`;

tester.run("loki/comments", commentsRule, {
  valid: [
    { code: inside("// oxlint-disable-next-line no-console -- a script's output is its console") },
    { code: inside("// react-doctor-disable-next-line react-doctor/async-await-in-loop") },
    { code: inside("// @ts-expect-error a grade is required") },
    { code: inside("// prettier-ignore") },
    { code: inside("// Explain the invariant directly in plain words.") },
    { code: inside("/** Document the contract across boundaries. */"), filename: "daemon/x.ts" },
    { code: inside("// Things to do later are tracked in issues, not code.") },
  ],
  invalid: [
    { code: inside("// oxlint-disable-next-line no-console"), errors: [{ messageId: "reason" }] },
    { code: inside("// eslint-disable-next-line no-console -- old prefix"), errors: [{ messageId: "directive" }] },
    { code: inside("// TODO: clean this up later"), errors: [{ messageId: "todo" }] },
    { code: inside("/* FIXME: race under load */"), errors: [{ messageId: "todo" }] },
    { code: inside("// const oldValue = computeOldValue();"), errors: [{ messageId: "code" }] },
  ],
});

describe("the lint as configured", () => {
  const lintAs = async (text: string) => (await new ESLint().lintText(text, { filePath: "daemon/probe.ts" }))[0]?.messages.map((m) => m.ruleId) ?? [];

  test("an ESLint directive cannot switch the rule off, on its own line or for the whole file", async () => {
    expect(await lintAs("export const a = 1; // eslint-disable-line -- a note\n")).toContain("loki/comments");
    expect(await lintAs("/* eslint-disable loki/comments */\n// TODO: a note\nexport const a = 1;\n")).toContain("loki/comments");
  });
});
