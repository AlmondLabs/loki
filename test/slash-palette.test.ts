import { describe, expect, test } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SlashCommand } from "../core/attention/commands.ts";
import { ThemeProvider } from "../app/src/theme.tsx";
import { SlashPalette } from "../app/src/chat/slash-palette.tsx";

// Plan 2026-11-12-1505, U20: the type-ahead list of commands, drawn as Liquid Glass draws it.

const noop = () => {};
const commands: SlashCommand[] = [
  { id: "model", description: "choose the model for this conversation", where: "loki" },
  { id: "review", args: "[branch]", description: "review the changes", where: "harness" },
];

const html = (el: ReactElement) => renderToStaticMarkup(createElement(ThemeProvider, null, el));
const palette = (matches: SlashCommand[]) => createElement(SlashPalette, { matches, index: 0, listId: "cmds", onHover: noop, onPick: noop });

describe("the command list", () => {
  test("names each command in the system font, starts its description with a capital, and has no line of key hints", () => {
    const out = html(palette(commands));
    expect(out).toContain('aria-label="Commands"');
    expect(out).toContain("Choose the model for this conversation");
    expect(out).toContain("Review the changes");
    expect(out).not.toContain("var(--loki-mono)");
    expect(out).not.toContain("fill in");
  });

  test("says what Return does when nothing matches, as a sentence", () => {
    expect(html(palette([]))).toMatch(/No command matches\. \S+ sends it as a message\./);
  });
});
