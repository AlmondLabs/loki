import { describe, expect, test } from "vitest";
import { ESLint, RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { commentsRule } from "../eslint-comments.mjs";

RuleTester.describe = describe;
RuleTester.it = test;
RuleTester.itOnly = test.only;

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });
const code = (comment: string) => `${comment}\nexport const x = 1;`;
const inside = (comment: string) => `export const x = 1;\n${comment}\nexport const y = 2;`;

tester.run("loki/comments", commentsRule, {
  valid: [
    { code: inside("// oxlint-disable-next-line no-console -- a script's output is its console") },
    { code: inside("// react-doctor-disable-next-line react-doctor/async-await-in-loop") },
    { code: inside("// @ts-expect-error a grade is required") },
    { code: inside("// @ts-expect-error") },
    { code: inside("// prettier-ignore") },
    { code: "export const m = import(/* @vite-ignore */ 'x');" },
    { code: inside("/** The frame a peer sends when it pairs. */"), filename: "daemon/x.ts" },
    { code: inside("/** A row on the wire. */"), filename: "app/src/x.ts" },
    { code: inside("// how Slack marks a thread read: https://github.com/emacs-slack/emacs-slack") },
    { code: code("// Copyright (c) 2024 someone\n// Permission is hereby granted"), filename: "mod/x.ts" },
    { code: inside("// Outside (WebKit): CSP refusals skip console.error, so they are reported here.") },
    { code: inside("// Outside (Windows): npx is a .cmd shim,\n// which runs only through a shell.") },
  ],
  invalid: [
    { code: inside("// the cursor moves on"), errors: [{ messageId: "comment" }] },
    { code: inside("/* the cursor moves on */"), errors: [{ messageId: "comment" }] },
    { code: inside("// oxlint-disable-next-line no-console"), errors: [{ messageId: "reason" }] },
    { code: inside("/** What the budget holds. */"), filename: "scripts/x.ts", errors: [{ messageId: "comment" }] },
    { code: inside("/** A fake. */"), filename: "test/x.test.ts", errors: [{ messageId: "comment" }] },
    { code: code("// The entry: React Scan goes first."), filename: "app/src/main.tsx", errors: [{ messageId: "comment" }] },
    { code: inside("// Outside (Gremlins): they ate the cache."), errors: [{ messageId: "unlisted", data: { name: "Gremlins" } }] },
    { code: inside("// npx is a .cmd shim,\n// Outside (Windows): which runs only through a shell."), errors: [{ messageId: "comment" }] },
    { code: inside("// eslint-disable-next-line no-console -- old prefix"), errors: [{ messageId: "comment" }] },
    { code: inside("// Outside (Node): an unhandled rejection ends the process.\nexport const z = 3; // a note"), errors: [{ messageId: "comment" }] },
    { code: "export const a = 1; // Outside (Node): x\n// a note\nexport const b = 2;", errors: [{ messageId: "comment" }] },
    { code: inside("// Copyright (c) 2024 someone"), errors: [{ messageId: "comment" }] },
  ],
});

describe("the lint as configured", () => {
  const lintAs = async (text: string) => (await new ESLint().lintText(text, { filePath: "daemon/probe.ts" }))[0]?.messages.map((m) => m.ruleId) ?? [];

  test("an ESLint directive cannot switch the rule off, on its own line or for the whole file", async () => {
    expect(await lintAs("export const a = 1; // eslint-disable-line -- a note\n")).toContain("loki/comments");
    expect(await lintAs("/* eslint-disable loki/comments */\n// a note\nexport const a = 1;\n")).toContain("loki/comments");
  });
});

describe("the rule's words", () => {
  test("tell a writer to rename, extract or type before listing what may stay", () => {
    const words = commentsRule.meta?.messages?.comment ?? "";
    expect(words.indexOf("name")).toBeLessThan(words.indexOf("Outside"));
    expect(words).toContain("docs/style.md §5");
  });
});
