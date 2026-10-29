import { describe, expect, test } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Conversation } from "../app/src/chat/conversation.tsx";
import {
  SuggestionCardView,
  afterAction,
  bumpTick,
  busyWith,
  chatChoices,
  chipText,
  tickOf,
  waitingCount,
  pickerKey,
  targetOf,
  type SuggestionCardProps,
  type SuggestionSource,
} from "../app/src/chat/suggestion-card.tsx";
import { OpenChat, Transcript, type TranscriptRow } from "../app/src/chat/transcript.tsx";
import { FrameChatClient } from "../core/attention/chat-client.ts";
import type { ConversationInfo } from "../core/attention/model.ts";
import type { Suggestion } from "../core/frame-types.ts";
import { must } from "./fixtures/must.ts";

/**
 * The suggestion card (plan 049, U4): an agent's suggestions for other chats show in the chat screen where they were
 * made, behind a chip in the message box (plan 052), on the desktop and the phone; each one line until opened, then
 * the message with send now, save as draft, change chat and reject.
 */

const suggestion = (over: Partial<Suggestion> = {}): Suggestion => ({
  id: "sugg-1",
  title: "Fix the flaky upload test",
  text: "The upload test fails one run in ten: the fixture's clock is real.",
  target: { agent_id: "ira", conversation_id: "infra" },
  status: "pending",
  reason: null,
  created_at: "2026-10-29T10:00:00Z",
  ...over,
});

const chat = (agentId: string, id: string, title: string | null, at: string): ConversationInfo => ({
  id,
  agent_id: agentId,
  agent_name: null,
  title,
  last_message_at: at,
  archived: false,
});

const ITEMS = [chat("ira", "infra", "infra", "2026-10-29T09:00:00Z"), chat("friday", "data", "data pipelines", "2026-10-29T11:00:00Z")];
const AGENTS = [
  { id: "ira", name: "ira" },
  { id: "friday", name: "friday" },
];

/** useAttention's part the cards read, faked: one chat's suggestions, the lists, and the actions recorded. */
function source(suggestions: Suggestion[], over: Partial<SuggestionSource> = {}) {
  const calls: Array<{ kind: string; id: string; arg: unknown }> = [];
  const src: SuggestionSource = {
    conversation: () => ({ suggestions, cwd: "/work/loki" }),
    items: ITEMS,
    agents: AGENTS,
    listed: true,
    agentsLoaded: true,
    suggestions: {
      decide: (_rt, id, action) => (calls.push({ kind: "decide", id, arg: action }), Promise.resolve({ done: true, message: null, suggestion: null })),
      retarget: (_rt, id, target) => (calls.push({ kind: "retarget", id, arg: target }), Promise.resolve({ done: true, message: null, suggestion: null })),
    },
    ...over,
  };
  return { src, calls };
}

const RT = { agent_id: "friday", conversation_id: "data" };

const conversation = (src: SuggestionSource, touch: boolean, composer = true, suggestionsTick = 0) =>
  renderToStaticMarkup(
    createElement(Conversation, {
      touch,
      composer,
      view: { rows: [], status: "idle" },
      actions: { onSend: () => {} },
      suggestions: { source: src, rt: RT },
      suggestionsTick,
    }),
  );

const cards = (html: string) => [...html.matchAll(/data-suggestion="([^"]+)"/g)].map((m) => m[1]);

/** Every element of a tree drawn by calling a component, its children followed, to press a button without a DOM. */
function elements(node: ReactNode): Array<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  // The card's own parts hold no state, so calling them shows what they draw; other components stay as they are.
  if (typeof el.type === "function" && el.type.name.startsWith("Suggestion"))
    return [el, ...elements((el.type as (props: Record<string, unknown>) => ReactNode)(el.props))];
  return [el, ...elements(el.props.children as ReactNode)];
}

type ViewProps = SuggestionCardProps & { picking: boolean; onPicking: (picking: boolean) => void };
const cardProps = (over: Partial<ViewProps> = {}): ViewProps => ({
  suggestion: suggestion(),
  target: { name: "infra · ira", gone: false },
  open: true,
  onToggle: () => {},
  note: null,
  busy: false,
  blocked: null,
  touch: false,
  onDecide: () => {},
  picker: () => null,
  picking: false,
  onPicking: () => {},
  ...over,
});
const card = (over: Partial<ViewProps> = {}) => renderToStaticMarkup(createElement(SuggestionCardView, cardProps(over)));
const actionsOf = (html: string) => [...html.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]);

describe("where suggestions show", () => {
  const two = [
    suggestion({ id: "older", created_at: "2026-10-29T09:00:00Z" }),
    suggestion({ id: "newer", created_at: "2026-10-29T10:00:00Z" }),
    suggestion({ id: "done", status: "sent" }),
  ];
  for (const touch of [false, true]) {
    test(`${touch ? "phone" : "desktop"}: two pending suggestions wait behind a chip in the box, before mic and send (plan 052)`, () => {
      const html = conversation(source(two).src, touch);
      expect(cards(html)).toEqual([]);
      const chip = html.indexOf("loki-suggestion-chip");
      expect(chip).toBeGreaterThan(html.indexOf("loki-composer"));
      expect(chip).toBeLessThan(html.indexOf("loki-composer-end"));
      expect(html).toContain(`aria-label="2 suggestions"`);
    });
    test(`${touch ? "phone" : "desktop"}: the host's tick opens them, newest first, in the box's ${touch ? "sheet" : "popover"}`, () => {
      const html = conversation(source(two).src, touch, true, 1);
      expect(cards(html)).toEqual(["newer", "older"]);
      expect(html).toContain(touch ? "loki-suggestion-sheet" : "loki-suggestion-popover");
      expect(html.indexOf("loki-suggestions")).toBeGreaterThan(html.indexOf("loki-composer"));
    });
  }
  test("a hidden view (composer false) draws no chip: the view on screen draws it once", () => {
    expect(conversation(source(two).src, false, false)).not.toContain("loki-suggestion-chip");
  });
  test("a chat with none draws no chip", () => {
    expect(conversation(source([]).src, false, true, 1)).not.toContain("loki-suggestion-chip");
  });
  test("one waiting suggestion opens straight to its message", () => {
    const html = conversation(source([suggestion()]).src, false, true, 1);
    expect(actionsOf(html)).toEqual(["send", "draft", "change", "reject"]);
  });
});

describe("the chip's words and the host's bumps (plan 052)", () => {
  test("desktop says how many, lowercase; the phone's narrow row shows the count by the icon", () => {
    expect(chipText(1, false)).toBe("1 suggestion");
    expect(chipText(3, false)).toBe("3 suggestions");
    expect(chipText(3, true)).toBe("3");
    expect(chipText(0, false)).toBe("suggestions");
    expect(chipText(0, true)).toBe("");
  });
  test("the count is the pending and sending ones of that chat", () => {
    const src = source([suggestion({ id: "a" }), suggestion({ id: "b", status: "sending" }), suggestion({ id: "c", status: "sent" })]).src;
    expect(waitingCount(src, RT)).toBe(2);
  });
  test("a bump belongs to its chat: another chat's card gets 0, and bumping it starts again", () => {
    const one = bumpTick(bumpTick(null, "x"), "x");
    expect(tickOf(one, "x")).toBe(2);
    expect(tickOf(one, "y")).toBe(0);
    expect(bumpTick(one, "y")).toEqual({ id: "y", n: 1 });
  });
});

describe("one card", () => {
  test("closed: one line with its title and where it goes, no message and no buttons", () => {
    const html = card({ open: false });
    expect(html).toContain("Fix the flaky upload test");
    expect(html).toContain("→ infra · ira");
    expect(html).not.toContain("fixture&#x27;s clock");
    expect(actionsOf(html)).toEqual([]);
  });
  test("opened on the desktop: the message, then send now, save as draft, change chat and reject, lowercase", () => {
    const html = card();
    expect(html).toContain("fixture&#x27;s clock is real");
    expect(actionsOf(html)).toEqual(["send", "draft", "change", "reject"]);
    for (const words of ["send now", "save as draft", "change chat", "reject"]) expect(html).toContain(`>${words}<`);
  });
  test("opened on the phone: the same actions in sentence case", () => {
    const html = card({ touch: true });
    for (const words of ["Send now", "Save as draft", "Change chat", "Reject"]) expect(html).toContain(`>${words}<`);
  });
  test("each button decides with its own action", () => {
    const decided: string[] = [];
    let picking = false;
    const tree = SuggestionCardView(cardProps({ onDecide: (a) => decided.push(a), onPicking: (p) => (picking = p) }));
    for (const action of ["send", "draft", "reject", "change"]) {
      const button = must(
        elements(tree).find((e) => e.props["data-action"] === action),
        action,
      );
      (button.props.onClick as () => void)();
    }
    expect(decided).toEqual(["send", "draft", "reject"]);
    expect(picking).toBe(true);
  });
  test("one being sent says so and offers nothing to press", () => {
    const html = card({ suggestion: suggestion({ status: "sending" }) });
    expect(html).toContain("sending…");
    expect(actionsOf(html)).toEqual([]);
  });
  test("covers AE6: a refused action shows its reason on the card", () => {
    expect(card({ note: "already sent from the phone" })).toContain("already sent from the phone");
  });
  test("covers AE6: a refusal for one already settled elsewhere is told after its card goes; one still waiting stays on the card", () => {
    const s = suggestion();
    expect(afterAction(s, { done: false, message: "already sent from the phone", suggestion: suggestion({ status: "sent" }) })).toEqual({
      told: { title: s.title, message: "already sent from the phone" },
    });
    expect(afterAction(s, { done: false, message: "the Mac friday lives on is out of reach", suggestion: null })).toEqual({
      note: "the Mac friday lives on is out of reach",
    });
    expect(afterAction(s, { done: true, message: null, suggestion: suggestion({ status: "sent" }) })).toBeNull();
  });
  test("on the phone, the buttons are disabled while the Mac is out of reach, and the card says why", () => {
    const html = card({ touch: true, blocked: "Mac unreachable: these wait until it is back" });
    expect(html).toContain("Mac unreachable: these wait until it is back");
    const buttons = [...html.matchAll(/<button[^>]*data-action="[^"]+"[^>]*>/g)].map((m) => m[0]);
    expect(buttons).toHaveLength(4);
    for (const b of buttons) expect(b).toContain("disabled");
  });
});

describe("covers AE7: a target that is gone", () => {
  const lists = { items: ITEMS, agents: AGENTS, listed: true, agentsLoaded: true };
  test("a chat no longer listed is gone: the card asks for another chat and offers no send", () => {
    const s = suggestion({ target: { agent_id: "ira", conversation_id: "deleted-chat" } });
    const target = targetOf(lists, s);
    expect(target.gone).toBe(true);
    const html = card({ suggestion: s, target });
    expect(actionsOf(html)).toEqual(["change", "reject"]);
    expect(html).toContain("pick another chat");
  });
  test("the Mac's own refusal says so too", () => {
    const s = suggestion({ reason: "the chat this was for is gone: pick another chat" });
    expect(targetOf(lists, s).gone).toBe(true);
    expect(targetOf(lists, suggestion({ reason: "the chat this was for is archived: pick another chat" })).gone).toBe(true);
    // A draft waiting there is not a gone chat: send still goes.
    expect(targetOf(lists, suggestion({ reason: "that chat already holds a saved draft: send it there first, or pick another chat" })).gone).toBe(false);
  });
  test("an agent that is gone, for a new chat", () => {
    expect(targetOf(lists, suggestion({ target: { agent_id: "nobody", folder: "/work" } })).gone).toBe(true);
  });
  test("before the lists came, nothing is gone yet", () => {
    const s = suggestion({ target: { agent_id: "ira", conversation_id: "not-listed-yet" } });
    expect(targetOf({ ...lists, items: [], listed: false }, s).gone).toBe(false);
  });
  test("the target's name: the chat and its agent, or a new chat with an agent in a folder", () => {
    expect(targetOf(lists, suggestion()).name).toBe("infra · ira");
    expect(targetOf(lists, suggestion({ target: { agent_id: "friday", folder: "/work/loki" } })).name).toBe("new chat with friday in loki");
    expect(targetOf(lists, suggestion({ target: { agent_id: "friday", folder: "/work/loki" } }), true).name).toBe("New chat with friday in loki");
  });
});

describe("change chat", () => {
  const lists = { items: ITEMS, agents: AGENTS };
  test("with nothing typed: the latest chats, then a new chat with each agent; the current target left out", () => {
    const choices = chatChoices(lists, "", { agent_id: "ira", conversation_id: "infra" });
    expect(choices.map((c) => c.title)).toEqual(["data pipelines", "new chat with ira", "new chat with friday"]);
  });
  test("typed: the chats and agents that match, a chat by its agent too", () => {
    const choices = chatChoices(lists, "ira", null);
    expect(choices.map((c) => c.key)).toEqual(["agent:ira", "chat:ira/infra"]);
    expect(chatChoices(lists, "pipe", null).map((c) => c.conversationId)).toEqual(["data"]);
  });
});

describe("actions in flight", () => {
  test("each card waits on its own answer: one answering leaves another still busy", () => {
    const both = busyWith(busyWith(new Set(), "sugg-a", true), "sugg-b", true);
    const left = busyWith(both, "sugg-a", false);
    expect([...left]).toEqual(["sugg-b"]);
    expect([...both]).toEqual(["sugg-a", "sugg-b"]);
  });
  test("an answer for a suggestion not in flight changes nothing", () => {
    expect([...busyWith(new Set(["sugg-b"]), "sugg-a", false)]).toEqual(["sugg-b"]);
  });
});

describe("change chat's keys", () => {
  const press = (key: string, disabled: boolean) => {
    const seen: string[] = [];
    const e = { key, preventDefault: () => seen.push("prevented"), stopPropagation: () => seen.push("stopped") };
    pickerKey(
      e,
      disabled,
      () => seen.push("enter"),
      () => seen.push("escape"),
    );
    return seen;
  };
  test("Enter chooses and Esc goes back, both kept from the Inbox's keys", () => {
    expect(press("Enter", false)).toEqual(["stopped", "prevented", "enter"]);
    expect(press("Escape", false)).toEqual(["stopped", "prevented", "escape"]);
  });
  test("while a change is in flight Enter does nothing, so a second Enter sends no second change; Esc still goes back", () => {
    expect(press("Enter", true)).toEqual(["stopped", "prevented"]);
    expect(press("Escape", true)).toEqual(["stopped", "prevented", "escape"]);
  });
});

describe("the frames an action sends", () => {
  test("decide and retarget send the suggestion's id, with the action or the new target", async () => {
    const sent: Array<{ type: string; payload: unknown }> = [];
    const client = new FrameChatClient({
      request: ((type: string, payload: unknown) => (
        sent.push({ type, payload }),
        Promise.resolve({ ok: true, reply: { suggestion: suggestion(), done: true, message: null } })
      )) as never,
      onChatEvent: () => () => {},
    });
    await client.suggestions.decide(RT, "sugg-1", "draft");
    await client.suggestions.retarget(RT, "sugg-1", { agent_id: "ira", folder: "/work/loki" });
    expect(sent).toEqual([
      { type: "suggestion_decide", payload: { agent_id: "friday", conversation_id: "data", suggestion_id: "sugg-1", action: "draft" } },
      {
        type: "suggestion_retarget",
        payload: { agent_id: "friday", conversation_id: "data", suggestion_id: "sugg-1", target: { agent_id: "ira", folder: "/work/loki" } },
      },
    ]);
    client.close();
  });
});

describe("a message sent from a suggestion", () => {
  const event = { role: "event" as const, text: "suggested in another chat", summary: "Fix the flaky upload test", detail: null };
  const draw = (row: TranscriptRow, open: ((a: string, c: string) => void) | null) =>
    renderToStaticMarkup(createElement(OpenChat.Provider, { value: open }, createElement(Transcript, { rows: [row] })));
  test("is a chip that opens the chat it came from, when the row names it", () => {
    const linked = { ...event, link: { agent_id: "friday", conversation_id: "data" } };
    const html = draw(linked, () => {});
    expect(html).toMatch(/<button[^>]*class="loki-suggested-chip"/);
    expect(html).toContain("Fix the flaky upload test");
  });
  test("names the suggestion without a link when the row does not say where it came from", () => {
    const html = draw(event, () => {});
    expect(html).not.toContain("<button");
    expect(html).toContain("suggested in another chat");
  });
});
