import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatCardMeta } from "../app/src/workspace/catch-up-parts.tsx";
import { attentionItem } from "./fixtures/attention.ts";

const card = attentionItem("c1", { has_draft: true });

describe("a Flow chat card's meta line", () => {
  test("joins its parts with dots, since it sits in a line of text", () => {
    const text = renderToStaticMarkup(createElement(ChatCardMeta, { current: card, cameBack: true })).replace(/<[^>]+>/g, "");
    expect(text).toMatch(/^\S+ · back · new since you moved on · draft$/);
  });
});
