import { describe, expect, test } from "vitest";
import { opensChat } from "../app/src/desk/use-deck-keys.ts";
import { attentionItem } from "./fixtures/attention.ts";
import { outsideItem } from "./fixtures/outside-item.ts";

/** The desktop deck's O key (app/src/desk/use-deck-keys.ts): it opens the card's chat and leaves the deck. */

describe("O on a card", () => {
  test("a chat's card opens its chat", () => {
    expect(opensChat(attentionItem("c1"))).toBe(true);
  });
  test("an email or Slack thread has no chat to open, so O does nothing and the deck stays", () => {
    expect(opensChat(outsideItem("Quarterly numbers"))).toBe(false);
  });
  test("with no card up there is nothing to open", () => {
    expect(opensChat(undefined)).toBe(false);
  });
});
