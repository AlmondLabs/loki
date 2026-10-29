// A suggestion saved as a draft (plan 049, U5): it waits in its chat's message box on every surface while nothing is
// typed there, marks the chat's Inbox card, and goes when the chat sends or the box is emptied.
import { afterEach, describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createSavedDrafts, savedDrafts } from "../core/attention/use-attention.ts";
import { buildItems, keyOf } from "../core/attention/model.ts";
import { inboxQueue } from "../core/attention/queue.ts";
import { restAfterNext } from "../core/attention/rest.ts";
import { createDrafts, draftKey, drafts, type SavedLayer } from "../app/src/shared/drafts.ts";
import { Card, CardConversation } from "../app/src/phone/inbox.tsx";
import { ConversationHeader } from "../app/src/chat/conversation.tsx";
import { attentionItem } from "./fixtures/attention.ts";

/** A saved layer over a core registry, as the app's own is, with each box emptied of a draft recorded. */
function setup() {
  const saved = createSavedDrafts();
  const emptied: string[] = [];
  saved.onEmptied((agentId, conversationId) => emptied.push(keyOf(agentId, conversationId)));
  const parts = (key: string) => key.split("\u0000") as [string, string];
  const layer: SavedLayer = {
    text: (key) => saved.text(...parts(key)),
    subscribe: (fn) => saved.subscribe(fn),
    emptied: (key) => saved.emptied(...parts(key)),
  };
  const store = createDrafts(layer);
  const key = draftKey("a1", "c1");
  const save = (text: string) => saved.replace(new Map([[keyOf("a1", "c1"), text]]));
  return { saved, store, key, save, emptied };
}

describe("a saved draft in the message box", () => {
  test("opening a chat with a saved draft and an empty box fills the box", () => {
    const s = setup();
    s.save("look at the flaky upload test");
    expect(s.store.get(s.key)).toEqual({ text: "look at the flaky upload test", images: [] });
    // The same object on each read until it changes, as useSyncExternalStore needs.
    expect(s.store.get(s.key)).toBe(s.store.get(s.key));
  });

  test("AE8: text already typed stays, and the draft waits until the box is empty", () => {
    const s = setup();
    s.store.set(s.key, { text: "my own words", images: [] });
    s.save("look at the flaky upload test");
    expect(s.store.get(s.key).text).toBe("my own words");
    s.store.set(s.key, { text: "", images: [] });
    expect(s.store.get(s.key).text).toBe("look at the flaky upload test");
    expect(s.emptied).toEqual([]);
  });

  test("emptying a seeded box clears the saved draft, untouched or edited", () => {
    const s = setup();
    s.save("look at the flaky upload test");
    s.store.set(s.key, { text: "", images: [] });
    expect(s.emptied).toEqual([keyOf("a1", "c1")]);
    expect(s.store.get(s.key).text).toBe("");

    const t = setup();
    t.save("look at the flaky upload test");
    t.store.set(t.key, { text: "look at the flaky upload test today", images: [] });
    t.store.set(t.key, { text: "", images: [] });
    expect(t.emptied).toEqual([keyOf("a1", "c1")]);
    expect(t.store.get(t.key).text).toBe("");
  });

  test("a send spends the draft: the box empties and the daemon is not asked again", () => {
    const s = setup();
    s.save("look at the flaky upload test");
    s.store.set(s.key, { text: "look at the flaky upload test now", images: [] });
    // useAttention's send drops it first; the box's own clear follows.
    s.saved.drop("a1", "c1");
    s.store.set(s.key, { text: "", images: [] });
    expect(s.store.get(s.key).text).toBe("");
    expect(s.emptied).toEqual([]);
  });

  test("an open box hears a saved draft arrive and go", () => {
    const s = setup();
    let heard = 0;
    const off = s.store.subscribe(s.key, () => heard++);
    s.save("look at the flaky upload test");
    // The same list again tells nobody.
    s.save("look at the flaky upload test");
    s.saved.replace(new Map());
    off();
    expect(heard).toBe(2);
  });

  test("a store without a saved layer reads as before", () => {
    const store = createDrafts();
    expect(store.get(draftKey("a1", "c1")).text).toBe("");
  });
});

describe("one draft across the surfaces", () => {
  afterEach(() => savedDrafts.replace(new Map()));

  test("the desktop Inbox deck, the desk pane and the phone read one draft for one chat", () => {
    // The deck's card and the desk pane both read `drafts` under draftKey(agent, conversation); the phone's session
    // re-exports the same store.
    savedDrafts.replace(new Map([[keyOf("a1", "c1"), "look at the flaky upload test"]]));
    expect(drafts.get(draftKey("a1", "c1")).text).toBe("look at the flaky upload test");
    drafts.set(draftKey("a1", "c1"), { text: "typed on the desk", images: [] });
    expect(drafts.get(draftKey("a1", "c1")).text).toBe("typed on the desk");
    drafts.clear(draftKey("a1", "c1"));
  });

  test("the phone's Inbox card shows the saved draft in its box", () => {
    savedDrafts.replace(new Map([[keyOf("a1", "c1"), "look at the flaky upload test"]]));
    const html = withPage(() =>
      renderToStaticMarkup(
        createElement(CardConversation, {
          item: attentionItem("c1", { has_draft: true }),
          view: { rows: [], status: "idle" },
          card: { onSend: () => {}, onAnswer: () => {}, onCancelQueued: () => {} },
          onHold: () => {},
        }),
      ),
    );
    expect(html).toContain("look at the flaky upload test");
  });
});

describe("the Inbox mark and the purpose line", () => {
  test("the phone's Inbox card says Draft when its chat holds one, and nothing otherwise", () => {
    const card = (hasDraft: boolean) =>
      withPage(() => renderToStaticMarkup(createElement(Card, { item: attentionItem("c1", { has_draft: hasDraft }), role: "top", style: {} })));
    expect(card(true)).toContain(">Draft<");
    expect(card(false)).not.toContain("Draft");
  });

  test("AE5: a new chat holding only a draft is an Inbox card and rests under Next like any other", () => {
    const now = Date.parse("2026-10-29T10:00:00Z");
    const conv = { id: "c1", agent_id: "a1", agent_name: "ira", title: null, last_message_at: null, archived: false, has_draft: true };
    const [item] = buildItems([conv], new Map(), new Map(), {}, now);
    expect(inboxQueue([item]).map((i) => i.id)).toEqual(["c1"]);
    const rest = restAfterNext(item, undefined, true, now);
    expect(rest).not.toBeNull();
    const [rested] = buildItems([conv], new Map(), new Map(), {}, now, {}, {}, rest ? { [keyOf("a1", "c1")]: rest } : {});
    expect(rested.resting).toBe(true);
    expect(inboxQueue([rested])).toEqual([]);
  });

  test("the chat header shows its purpose under the name, and nothing when it has none", () => {
    const header = (purpose: string | null) =>
      withPage(() => renderToStaticMarkup(createElement(ConversationHeader, { title: "site", purpose, agentName: "ira", agentId: "a1" })));
    expect(header("the website: deploys and copy")).toContain("the website: deploys and copy");
    expect(header(null)).not.toContain("loki-chat-purpose");
  });
});

/** The card draws the agent's face, whose URL reads the page's token and origin: a bare page for the render, then put back. */
function withPage<T>(render: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, localStorage: g.localStorage, location: g.location };
  g.window = {};
  g.localStorage = { getItem: () => null };
  g.location = { origin: "http://127.0.0.1:5191", href: "http://127.0.0.1:5191/" };
  try {
    return render();
  } finally {
    Object.assign(g, saved);
  }
}
