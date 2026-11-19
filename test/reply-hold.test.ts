import { describe, expect, test } from "vitest";
import { createReplyHold, typedReplyOnCard } from "../app/src/shared/reply-hold.ts";
import { createDrafts, draftKey, EMPTY_DRAFT, type SavedLayer } from "../app/src/shared/drafts.ts";
import { createOutsideReplies } from "../app/src/shared/outside-replies.ts";

describe("the reply hold", () => {
  test("one holder holds until it drops", () => {
    const hold = createReplyHold();
    let changes = 0;
    hold.subscribe(() => changes++);
    expect(hold.held()).toBe(false);
    const drop = hold.raise();
    expect(hold.held()).toBe(true);
    drop();
    expect(hold.held()).toBe(false);
    expect(changes).toBe(2);
  });

  test("the deck and the inbox hold until both drop", () => {
    const hold = createReplyHold();
    const dropDeck = hold.raise();
    const dropInbox = hold.raise();
    dropDeck();
    expect(hold.held()).toBe(true);
    dropInbox();
    expect(hold.held()).toBe(false);
  });

  test("a holder that unmounts drops its hold, and dropping twice leaves the other holder's hold", () => {
    const hold = createReplyHold();
    const unmount = hold.raise();
    const other = hold.raise();
    unmount();
    unmount();
    expect(hold.held()).toBe(true);
    other();
    expect(hold.held()).toBe(false);
  });
});

describe("whether the Mac's card holds the switch", () => {
  const key = draftKey("a1", "c1");
  const outsideId = "a1/c1";
  const setup = (savedText: string | null = null) => {
    const saved: SavedLayer = { text: () => savedText, subscribe: () => () => {}, emptied: () => {} };
    return { drafts: createDrafts(saved), outside: createOutsideReplies() };
  };

  test("a focused but empty reply does not hold", () => {
    const { drafts, outside } = setup();
    drafts.set(key, EMPTY_DRAFT);
    expect(typedReplyOnCard(drafts, outside, key, outsideId)).toBe(false);
  });

  test("a card whose only text is a draft saved earlier in the chat does not hold", () => {
    const { drafts, outside } = setup("from the chat listing");
    expect(drafts.get(key).text).toBe("from the chat listing");
    expect(typedReplyOnCard(drafts, outside, key, outsideId)).toBe(false);
  });

  test("text typed on the card holds", () => {
    const { drafts, outside } = setup();
    drafts.set(key, { text: "on my way", images: [] });
    expect(typedReplyOnCard(drafts, outside, key, outsideId)).toBe(true);
    drafts.set(key, { text: "   ", images: [] });
    expect(typedReplyOnCard(drafts, outside, key, outsideId)).toBe(false);
  });

  test("an outside reply with text holds", () => {
    const { drafts, outside } = setup();
    outside.set(outsideId, "Thanks, will do");
    expect(typedReplyOnCard(drafts, outside, key, outsideId)).toBe(true);
    outside.set(outsideId, "");
    expect(typedReplyOnCard(drafts, outside, key, outsideId)).toBe(false);
  });
});
