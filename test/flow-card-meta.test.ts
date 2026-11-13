import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatCardMeta } from "../app/src/desk/catch-up-parts.tsx";
import { attentionItem } from "./fixtures/attention.ts";

// A Flow chat card's when-and-why line: spaced parts in today's card header, and dot-joined in the Liquid Glass
// toolbar's grey line, where they sit in running text and once ran together ("22mread").

const card = attentionItem("c1", { has_draft: true });

describe("a Flow chat card's meta line", () => {
  test("joins its parts with dots when it sits in a line of text", () => {
    const text = renderToStaticMarkup(createElement(ChatCardMeta, { current: card, cameBack: true, inline: true })).replace(/<[^>]+>/g, "");
    // The first part is how long ago, which reads the clock; the joins are what this is about.
    expect(text).toMatch(/^\S+ · back · new since you moved on · draft$/);
  });

  test("leaves its parts apart, unjoined, in today's spaced header", () => {
    const text = renderToStaticMarkup(createElement(ChatCardMeta, { current: card, cameBack: true })).replace(/<[^>]+>/g, "");
    expect(text).not.toContain(" · back");
  });
});
