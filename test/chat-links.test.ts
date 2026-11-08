import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHAT_LINK_MESSAGES_PER_HOUR,
  allows,
  expiresAt,
  linkAnswers,
  linkAskOf,
  linksSeenFrom,
  looserThan,
  lokiModeOf,
  parseLinkAnswer,
  stricterMode,
  timeLeft,
  type ChatLink,
  type LinkAnswer,
  type LinkAsk,
  type LokiMode,
} from "../core/chat-links.ts";
import { chatMessageBlock, chatMessageOf, extractHarnessEvents, stripHarnessMarkup } from "../core/harness.ts";
import { FRAMES } from "../core/frames.ts";
import { ChatMessages, LinkStore, type ChatKey, type LinkCall, type ListedChat } from "../mod/chat-links.ts";
import { applyChatEvent, emptyLive, faceOf, type ChatEvent } from "../core/attention/model.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LinkCard } from "../app/src/chat/link-card.tsx";
import { LinkHeader } from "../app/src/chat/link-header.tsx";

const A: ChatKey = { agent_id: "agent-a", conversation_id: "conv-a" };
const B: ChatKey = { agent_id: "agent-b", conversation_id: "conv-b" };
const T0 = new Date("2026-11-04T10:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const HOUR = 3_600_000;

const link = (over: Partial<ChatLink> = {}): ChatLink => ({
  id: "link-1",
  from: { ...A, title: "repo" },
  to: { ...B, title: "infra" },
  direction: "one_way",
  created_at: T0.toISOString(),
  expires_at: expiresAt("hour", T0),
  sent: [],
  ...over,
});

describe("the link rules", () => {
  test("one way lets only the chat that asked message the other; both ways lets each; neither once it ends", () => {
    expect(allows(link(), A, B, T0)).toBe(true);
    expect(allows(link(), B, A, T0)).toBe(false);
    expect(allows(link({ direction: "both_ways" }), B, A, T0)).toBe(true);
    expect(allows(link(), A, B, later(HOUR + 1))).toBe(false);
    expect(allows(link({ expires_at: null }), A, B, later(1000 * HOUR))).toBe(true);
  });

  test("an hour, a day, or until closed; the time left reads in minutes, then hours", () => {
    expect(expiresAt("hour", T0)).toBe("2026-11-04T11:00:00.000Z");
    expect(expiresAt("day", T0)).toBe("2026-11-05T10:00:00.000Z");
    expect(expiresAt("always", T0)).toBeNull();
    expect(timeLeft(link(), later(15 * 60_000))).toBe("45 min left");
    expect(timeLeft(link({ expires_at: expiresAt("day", T0) }), T0)).toBe("24 h left");
    expect(timeLeft(link({ expires_at: null }), T0)).toBe("until closed");
  });

  test("a turn gets the stricter of two modes, and a mode loki does not know never gives power", () => {
    expect(stricterMode("unrestricted", "standard")).toBe("standard");
    expect(stricterMode("strict", "unrestricted")).toBe("strict");
    expect(stricterMode("acceptEdits", null)).toBe("strict");
    expect(lokiModeOf(undefined, false)).toBe("unrestricted"); // loki's engine with no mode set runs unrestricted
    expect(lokiModeOf("bypassPermissions", true)).toBe("unrestricted");
    expect(lokiModeOf("default", true)).toBe("standard");
    expect(lokiModeOf("something-new", true)).toBeNull();
    // A chat on an ACP agent is refused when its mode has more power, or is one loki does not know.
    expect(looserThan("unrestricted", "standard")).toBe(true);
    expect(looserThan("standard", "standard")).toBe(false);
    expect(looserThan(null, "unrestricted")).toBe(true);
  });

  test("the card's answers go out and come back as the person picked them; anything else is a deny", () => {
    const answer: LinkAnswer = { allow: true, direction: "both_ways", duration: "day" };
    expect(parseLinkAnswer(linkAnswers(answer))).toEqual(answer);
    expect(parseLinkAnswer({ decision: "maybe" }).allow).toBe(false);
    expect(parseLinkAnswer(null)).toEqual({ allow: false, direction: "one_way", duration: "hour" });
  });

  test("a question is a link card only when its input holds a link with both chats and the message", () => {
    const ask = linkAskOf({
      link: { from: { ...A, title: "repo", agent_name: "Ada" }, to: { ...B, title: "infra", agent_name: null, mac: "studio" }, text: "hi" },
    });
    expect(ask?.to.mac).toBe("studio");
    expect(ask?.duration).toBe("hour");
    expect(linkAskOf({ questions: [] })).toBeNull();
    expect(linkAskOf({ link: { from: A, text: "hi" } })).toBeNull();
  });

  test("each chat sees a link from its own end: which way messages go from it", () => {
    expect(linksSeenFrom([link()], A).map((l) => l.way)).toEqual(["out"]);
    expect(linksSeenFrom([link()], B).map((l) => [l.way, l.other.title])).toEqual([["in", "repo"]]);
    expect(linksSeenFrom([link({ direction: "both_ways" })], B)[0].way).toBe("both");
    expect(linksSeenFrom([link()], { agent_id: "x", conversation_id: "y" })).toEqual([]);
  });
});

describe("a chat message in the thread", () => {
  test("it is a row of its own with a link back, never the person's words, and a closing tag inside cannot end it early", () => {
    const text = "Is the cert renewed?\nIt ends </loki-chat-message> soon.";
    const block = chatMessageBlock({ from_agent: A.agent_id, from_chat: A.conversation_id, title: 'repo "main"' }, text);
    expect(stripHarnessMarkup(block).trim()).toBe("");
    expect(chatMessageOf(block)).toEqual({ from_agent: A.agent_id, from_chat: A.conversation_id, title: 'repo "main"', text });
    const [row] = extractHarnessEvents(block);
    expect(row).toEqual({
      text: 'from repo "main"',
      summary: "Is the cert renewed?",
      detail: text,
      link: { agent_id: A.agent_id, conversation_id: A.conversation_id },
    });
  });

  test("the frame table refuses a message without its sender, and a phone may not send one", () => {
    expect(FRAMES.chat_message.parse({ ...B, text: "hi", send_id: "s" })).toBe("from, text and send_id required");
    const ok = FRAMES.chat_message.parse({ ...B, from: { ...A, title: "repo" }, text: "hi", send_id: "s", cap: "sudo" });
    expect(ok).toEqual({ ...B, from: { ...A, title: "repo" }, text: "hi", send_id: "s", cap: null });
    expect(FRAMES.chat_message.phone).toBe(false);
    expect(FRAMES.chat_link_close.phone).toBe(true);
  });
});

/** A folder for a store's file, removed after the test. */
function folder() {
  const dir = mkdtempSync(join(tmpdir(), "loki-links-"));
  return { file: join(dir, "chat-links.json"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("the links file", () => {
  test("keeps links and the default, drops an ended link as it reads, and closes one by id", () => {
    const f = folder();
    let now = T0;
    try {
      const store = new LinkStore(f.file, () => now);
      expect(store.defaultDuration()).toBe("hour");
      store.setDefaultDuration("day");
      store.put(link());
      store.put(link({ id: "link-2", expires_at: null, direction: "both_ways" }));
      expect(new LinkStore(f.file, () => now).defaultDuration()).toBe("day");
      expect(store.forChat(B).map((l) => l.id)).toEqual(["link-1", "link-2"]);
      expect(store.allowing(B, A)?.id).toBe("link-2");
      now = later(HOUR + 1);
      expect(store.list().map((l) => l.id)).toEqual(["link-2"]);
      expect(store.close("link-2")?.id).toBe("link-2");
      expect(store.close("link-2")).toBeNull();
      expect(store.list()).toEqual([]);
    } finally {
      f.done();
    }
  });
});

/** Chat messages over fakes: a store in a folder, a clock, chats in lists, the card's answers, and what was delivered. */
function setup(opts: { remote?: ChatKey[]; power?: LokiMode | null; answers?: LinkAnswer[]; refuse?: string; forwardFails?: boolean } = {}) {
  const f = folder();
  const clock = { now: T0 };
  const links = new LinkStore(f.file, () => clock.now);
  const asked: LinkAsk[] = [];
  const answers = [...(opts.answers ?? [])];
  const delivered: Array<{ ref: ChatKey; text: string; context: string; cap: LokiMode | null }> = [];
  const forwarded: LinkCall[] = [];
  const pushed: Array<{ conversationId: string; events: ChatEvent[] }> = [];
  const remote = (ref: ChatKey) => (opts.remote ?? []).some((r) => r.conversation_id === ref.conversation_id);
  const chats: Record<string, ListedChat> = {
    "conv-a": { title: "repo", agent_name: "Ada", mac: null, open: true },
    "conv-b": { title: "infra", agent_name: "Bo", mac: null, open: true },
    "conv-gone": { title: "old", agent_name: "Bo", mac: null, open: false },
  };
  let n = 0;
  const messages: ChatMessages = new ChatMessages({
    links,
    chat: (ref) => chats[ref.conversation_id] ?? null,
    here: (ref) => Promise.resolve(!remote(ref)),
    ask: (_source, ask) => {
      asked.push(ask);
      return Promise.resolve(answers.shift() ?? { allow: false, direction: "one_way", duration: "hour" });
    },
    forward: (frame) => {
      forwarded.push(frame);
      if (opts.forwardFails) return Promise.resolve({ ok: false, message: "Studio is out of reach" });
      return Promise.resolve({ ok: true, reply: { accepted: true } });
    },
    power: () => Promise.resolve(opts.power === undefined ? "standard" : opts.power),
    deliver: (ref, text, context, _sendId, cap) => {
      if (opts.refuse) return Promise.resolve(opts.refuse);
      delivered.push({ ref, text, context, cap });
      return Promise.resolve(null);
    },
    push: (_agentId, conversationId, events) => pushed.push({ conversationId, events }),
    now: () => clock.now,
    newId: () => `id-${String((n += 1))}`,
  });
  const signal = new AbortController().signal;
  const send = (from: ChatKey, to: ChatKey, text = "is the cert renewed?") => messages.send(from, to, text, signal);
  return { messages, links, clock, asked, delivered, forwarded, pushed, send, done: f.done };
}

const allow = (over: Partial<LinkAnswer> = {}): LinkAnswer => ({ allow: true, direction: "one_way", duration: "hour", ...over });

describe("an agent messages another chat", () => {
  test("with no link the person is asked; a deny sends nothing and tells the agent", async () => {
    const s = setup();
    try {
      const out = await s.send(A, B);
      expect(out.ok).toBe(false);
      expect(out.message).toContain("did not allow");
      expect(s.asked).toHaveLength(1);
      expect(s.asked[0]).toMatchObject({
        from: { title: "repo", agent_name: "Ada" },
        to: { title: "infra", agent_name: "Bo" },
        text: "is the cert renewed?",
        duration: "hour",
      });
      expect(s.delivered).toEqual([]);
      expect(s.links.list()).toEqual([]);
    } finally {
      s.done();
    }
  });

  test("an allow opens the link the person picked and delivers the message, held to the sender's power", async () => {
    const s = setup({ answers: [allow({ duration: "day" })], power: "acceptEdits" });
    try {
      const out = await s.send(A, B);
      expect(out).toEqual({ ok: true, message: 'sent to "infra". The link is one way: it cannot answer you.' });
      expect(s.links.list()).toMatchObject([
        { from: { ...A, title: "repo" }, to: { ...B, title: "infra" }, direction: "one_way", expires_at: "2026-11-05T10:00:00.000Z" },
      ]);
      expect(s.delivered).toHaveLength(1);
      expect(s.delivered[0].ref).toEqual(B);
      expect(s.delivered[0].cap).toBe("acceptEdits");
      expect(chatMessageOf(s.delivered[0].text)?.text).toBe("is the cert renewed?");
      expect(s.delivered[0].context).toContain("not from the person");
      expect(s.delivered[0].context).toContain("one way");
      // Both chats' screens hear of the link.
      expect(s.pushed.map((p) => p.conversationId).sort()).toEqual(["conv-a", "conv-b"]);
    } finally {
      s.done();
    }
  });

  test("along a live one-way link it goes without asking; back the other way it asks", async () => {
    const s = setup({ answers: [allow()] });
    try {
      await s.send(A, B);
      await s.send(A, B, "and the DNS?");
      expect(s.asked).toHaveLength(1);
      expect(s.delivered).toHaveLength(2);
      const back = await s.send(B, A, "renewed");
      expect(back.ok).toBe(false);
      expect(s.asked).toHaveLength(2);
    } finally {
      s.done();
    }
  });

  test("both ways lets the other chat answer without asking, and is told it may", async () => {
    const s = setup({ answers: [allow({ direction: "both_ways" })] });
    try {
      await s.send(A, B);
      expect(s.delivered[0].context).toContain("You may answer with chat_message");
      const back = await s.send(B, A, "renewed yesterday");
      expect(back.ok).toBe(true);
      expect(s.asked).toHaveLength(1);
      expect(s.delivered[1].ref).toEqual(A);
    } finally {
      s.done();
    }
  });

  test("an ended or closed link asks again", async () => {
    const s = setup({ answers: [allow(), allow({ duration: "always" })] });
    try {
      await s.send(A, B);
      s.clock.now = later(HOUR + 1);
      await s.send(A, B);
      expect(s.asked).toHaveLength(2);
      const [open] = s.links.list();
      expect(open.expires_at).toBeNull();
      expect(await s.messages.close(open.id, false)).toBe(true);
      await s.send(A, B);
      expect(s.asked).toHaveLength(3);
    } finally {
      s.done();
    }
  });

  test("the link carries at most its cap into a chat in an hour, then refuses until the hour moves on", async () => {
    const s = setup({ answers: [allow({ direction: "both_ways", duration: "always" })] });
    try {
      for (let i = 0; i < CHAT_LINK_MESSAGES_PER_HOUR; i += 1) expect((await s.send(A, B, `m${String(i)}`)).ok).toBe(true);
      const over = await s.send(A, B, "one more");
      expect(over.ok).toBe(false);
      expect(over.message).toContain(`${String(CHAT_LINK_MESSAGES_PER_HOUR)} messages`);
      // The other way has its own count.
      expect((await s.send(B, A, "answer")).ok).toBe(true);
      s.clock.now = later(HOUR + 1000);
      expect((await s.send(A, B, "next hour")).ok).toBe(true);
    } finally {
      s.done();
    }
  });

  test("a chat that is not open, the chat itself, and an empty message are refused without asking", async () => {
    const s = setup({ answers: [allow()] });
    try {
      expect((await s.send(A, { agent_id: "agent-b", conversation_id: "conv-gone" })).ok).toBe(false);
      expect((await s.send(A, A)).message).toBe("that is this chat");
      expect((await s.send(A, B, "  ")).ok).toBe(false);
      expect(s.asked).toEqual([]);
    } finally {
      s.done();
    }
  });

  test("a chat the receiving side refuses (an ACP agent in a looser mode) leaves the agent told why", async () => {
    const s = setup({ answers: [allow()], refuse: "that chat runs in a mode with more power" });
    try {
      const out = await s.send(A, B);
      expect(out).toEqual({ ok: false, message: "that chat runs in a mode with more power" });
    } finally {
      s.done();
    }
  });
});

describe("a link to a chat on another Mac", () => {
  test("the link goes to that Mac before the message, and both go there", async () => {
    const s = setup({ remote: [B], answers: [allow()] });
    try {
      expect((await s.send(A, B)).ok).toBe(true);
      expect(s.forwarded.map((f) => f.type)).toEqual(["chat_link_put", "chat_message"]);
      expect(s.forwarded[1]).toMatchObject({ type: "chat_message", ...B, from: { ...A, title: "repo" }, cap: "standard" });
      // Only the chat here is told on this Mac.
      expect(s.pushed.map((p) => p.conversationId)).toEqual(["conv-a"]);
    } finally {
      s.done();
    }
  });

  test("a Mac that does not take the link leaves no link here, and the agent hears why", async () => {
    const s = setup({ remote: [B], answers: [allow()], forwardFails: true });
    try {
      const out = await s.send(A, B);
      expect(out.ok).toBe(false);
      expect(out.message).toContain("Studio is out of reach");
      expect(s.links.list()).toEqual([]);
    } finally {
      s.done();
    }
  });

  test("a message another Mac says is allowed is refused when this Mac holds no link for it", async () => {
    const s = setup();
    try {
      const out = await s.messages.receive({ type: "chat_message", ...B, from: { ...A, title: "repo" }, text: "hi", send_id: "x", cap: "unrestricted" });
      expect(out.ok).toBe(false);
      expect(s.delivered).toEqual([]);
    } finally {
      s.done();
    }
  });

  test("closing passes the close on to the other chat's Mac, but not back to a Mac that passed it here", async () => {
    const s = setup({ remote: [B] });
    try {
      s.messages.put(link());
      expect(await s.messages.close("link-1", false)).toBe(true);
      expect(s.forwarded).toEqual([{ type: "chat_link_close", ...B, link_id: "link-1" }]);
      s.messages.put(link());
      expect(await s.messages.close("link-1", true)).toBe(true);
      expect(s.forwarded).toHaveLength(1);
    } finally {
      s.done();
    }
  });
});

describe("the link card and the header", () => {
  const ask: LinkAsk = {
    from: { ...A, title: "repo", agent_name: "Ada" },
    to: { ...B, title: "infra", agent_name: "Bo", mac: "studio" },
    text: "Is the cert renewed?",
    duration: "day",
  };

  test("the card names the other chat and its Mac, shows the message, and offers both directions, three durations, allow and deny", () => {
    const html = renderToStaticMarkup(createElement(LinkCard, { requestId: "q1", ask, onAnswer: () => {} }));
    expect(html).toContain("wants to message another chat");
    expect(html).toContain("infra (Bo on studio)");
    expect(html).toContain("Is the cert renewed?");
    for (const words of ["one way", "both ways", "1 hour", "1 day", "until I close it", "allow", "deny"]) expect(html).toContain(words);
    // It starts on one way and on the default duration Preferences set.
    expect(html).toMatch(/aria-checked="true"[^>]*aria-label="direction: one way"/);
    expect(html).toMatch(/aria-checked="true"[^>]*aria-label="for: 1 day"/);
    const phone = renderToStaticMarkup(createElement(LinkCard, { requestId: "q1", ask, onAnswer: () => {}, touch: true }));
    expect(phone).toContain("Both ways");
    expect(phone).toContain("Allow");
  });

  test("the header shows each live link's other chat, its way and time left, and leaves out one that ended", () => {
    const now = Date.now();
    const seen = [
      { id: "l1", other: { ...B, title: "infra" }, way: "out" as const, expires_at: new Date(now + 30 * 60_000).toISOString() },
      { id: "l2", other: { ...B, title: "old" }, way: "both" as const, expires_at: new Date(now - 1000).toISOString() },
    ];
    const html = renderToStaticMarkup(createElement(LinkHeader, { links: seen, onClose: () => {} }));
    expect(html).toContain("infra");
    expect(html).toContain("min left");
    expect(html).toContain("close link to infra");
    expect(html).not.toContain("old");
  });

  test("several live links fold into one chip that says how many, so the header stays one line", () => {
    const later = new Date(Date.now() + 2 * 3600_000).toISOString();
    const seen = ["infra", "release", "secrets", "router"].map((title, i) => ({
      id: `l${String(i)}`,
      other: { ...B, title },
      way: "both" as const,
      expires_at: later,
    }));
    const html = renderToStaticMarkup(createElement(LinkHeader, { links: seen, onClose: () => {} }));
    expect(html).toContain("4 links");
    expect(html).toContain('aria-haspopup="dialog"');
    // The list opens on a click; closed, no other chat's name crowds the header.
    for (const title of ["infra", "release", "secrets", "router"]) expect(html).not.toContain(title);
    const phone = renderToStaticMarkup(createElement(LinkHeader, { links: seen, touch: true }));
    expect(phone).toContain("4 links");
  });
});

describe("a chat's links in the live state", () => {
  test("a links event changes the chat's face, so its header redraws when a link opens or closes", () => {
    const l = emptyLive();
    const before = faceOf(l);
    expect(applyChatEvent(l, { kind: "links", links: [link()] }).changed).toBe(true);
    expect(faceOf(l)).not.toEqual(before);
    const open = faceOf(l);
    applyChatEvent(l, { kind: "links", links: [] });
    expect(faceOf(l)).not.toEqual(open);
  });
});
