import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { answerOf, consultOf } from "../core/advisor.ts";
import { ADVISOR_PROMPT } from "../daemon/advisor.ts";
import { ADVISOR_TOOLS } from "../daemon/advisor-gate.ts";
import type { DaemonChats } from "../daemon/chat-backend.ts";
import type { AgentStore } from "../daemon/kernel/index.ts";
import { ChatMoves } from "../mod/chat-moves.ts";
import { AGENT, consultSetup, gate, until } from "./fixtures/advisor-consult.ts";
import { must } from "./fixtures/must.ts";

const ctx = BACKGROUND_CONTEXT;
const BOOK = "aaaaaaaa-1111-4111-8111-111111111111";
const MINI = "bbbbbbbb-2222-4222-8222-222222222222";

const unchanged = { title: undefined, hidden: undefined, labels: undefined } as const;

async function infoOf(store: AgentStore, id: string) {
  return must(await store.chatInfo(must(await store.chat(id, ctx), `chat ${id}`).id, ctx), `info of ${id}`);
}

async function kinds(store: AgentStore, id: string): Promise<string[]> {
  const chat = must(await store.chat(id, ctx), `chat ${id}`);
  return (await store.entries(chat, ctx)).map((e) => `${e.kind}:${JSON.stringify(e.model ?? null).slice(0, 80)}`);
}

function twoMacs(book: DaemonChats, mini: DaemonChats) {
  const dir = mkdtempSync(join(tmpdir(), "loki-advisor-moves-"));
  const names: Record<string, string> = { [BOOK]: "MacBook", [MINI]: "Mac mini" };
  const across = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const link = (from: string, to: () => ChatMoves) => ({
    request: async (f: Record<string, unknown>) => {
      const [a, c] = [String(f.agent_id), String(f.conversation_id)];
      if (f.type === "peer_chat_export") return across(await to().export(from, a, c));
      if (f.type === "peer_chat_moved") return (await to().moved(from, a, c), {});
      if (f.type === "peer_chat_take") return across(await to().take(from, a, c));
      if (f.type === "peer_where") return { held: false, moved_to: null };
      throw new Error(`unexpected ${String(f.type)}`);
    },
  });
  const mac = (here: string, chat: DaemonChats, other: () => ChatMoves) =>
    new ChatMoves({
      here,
      chat,
      held: chat,
      link: (id) => (names[id] ? (link(here, other) as never) : null),
      widgetsDir: join(dir, here),
      name: (id) => (id === null ? names[here] : (names[id] ?? null)),
      done: () => true,
      markDone: () => {},
      onMoved: () => {},
      onLeft: () => {},
    });
  const macs: { book: ChatMoves; mini: ChatMoves } = {
    book: mac(BOOK, book, () => macs.mini),
    mini: mac(MINI, mini, () => macs.book),
  };
  return { ...macs, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("archiving a chat with an advisor", () => {
  test("drops the consults waiting with no row, stops the advisor and archives it; unarchiving brings both chats back, not the consults (AE7)", async () => {
    const s = await consultSetup();
    try {
      const d = s.first;
      const held = gate();
      s.replies.advisor = async () => (await held.wait, fauxAssistantMessage("too late"));
      const ref = { agent_id: AGENT, conversation_id: s.chatId };
      await d.chats.consult(ref, "agent", "one");
      await d.chats.consult(ref, "person", "two");
      await until(() => s.seen.advisor.length === 1);
      const archiving = d.chats.update({ ...ref, ...unchanged, archived: true });
      held.open();
      await archiving;
      expect((await s.ledger(d)).map((c) => c.state)).toEqual(["dropped", "dropped"]);
      expect(await d.chats.busy(AGENT, `advisor-${s.chatId}`)).toBe(false);
      expect(await infoOf(d.store, s.chatId)).toMatchObject({ archived: true });
      expect(await infoOf(d.store, `advisor-${s.chatId}`)).toMatchObject({ archived: true, hidden: true });
      expect(await s.answers(d)).toEqual([]);

      await d.chats.update({ ...ref, ...unchanged, archived: false });
      expect(await infoOf(d.store, s.chatId)).toMatchObject({ archived: false });
      expect(await infoOf(d.store, `advisor-${s.chatId}`)).toMatchObject({ archived: false, hidden: true });
      expect((await s.ledger(d)).map((c) => c.state)).toEqual(["dropped", "dropped"]);
      expect(s.seen.advisor).toHaveLength(1);
      expect(await s.answers(d)).toEqual([]);
    } finally {
      await s.cleanup();
    }
  });
});

describe("an advisor and its chat's folder", () => {
  test("a folder change while a consult runs leaves that run in the old folder; the next consult runs in the new one", async () => {
    const s = await consultSetup();
    try {
      const d = s.first;
      const held = gate();
      const advise = s.replies.advisor;
      s.replies.advisor = async (text) => (await held.wait, advise(text));
      const ref = { agent_id: AGENT, conversation_id: s.chatId };
      await d.chats.consult(ref, "agent", "first look");
      await until(() => s.seen.advisor.length === 1);
      const advisor = must(await d.store.chat(`advisor-${s.chatId}`, ctx), "the advisor chat");
      const elsewhere = join(s.root, "home", "elsewhere");
      mkdirSync(elsewhere, { recursive: true });
      await d.chats.folder(AGENT, s.chatId, elsewhere);
      expect((await advisor.agent(ctx)).cwd).toBe(s.folder);
      held.open();
      await s.settled(d);
      expect((await advisor.agent(ctx)).cwd).toBe(s.folder);
      await d.chats.consult(ref, "agent", "second look");
      await s.settled(d);
      expect((await advisor.agent(ctx)).cwd).toBe(elsewhere);
    } finally {
      await s.cleanup();
    }
  });
});

describe("a move asked while the advisor answers", () => {
  test("is held on the chat, the queued consult waits, and once the answer has landed and the chat is idle the move is ready", async () => {
    const s = await consultSetup();
    try {
      const d = s.first;
      const held = gate();
      const advise = s.replies.advisor;
      s.replies.advisor = async (text) => (await held.wait, advise(text));
      const ref = { agent_id: AGENT, conversation_id: s.chatId };
      expect(await d.chats.holdMove(AGENT, s.chatId, MINI)).toBe(false);
      await d.chats.consult(ref, "agent", "first look");
      await d.chats.consult(ref, "person", "second look");
      await until(() => s.seen.advisor.length === 1);
      expect(await d.chats.exportChat(AGENT, s.chatId)).toEqual({ chat: null, busy: true });
      expect(await d.chats.holdMove(AGENT, s.chatId, MINI)).toBe(true);
      expect(await d.chats.heldMoves()).toEqual([]);
      held.open();
      await until(async () => (await d.chats.heldMoves()).length === 1);
      expect(await d.chats.heldMoves()).toEqual([{ agent_id: AGENT, conversation_id: s.chatId, to: MINI }]);
      expect((await s.ledger(d)).map((c) => c.state)).toEqual(["answered", "queued"]);
      expect(await s.answers(d)).toHaveLength(1);
      expect(s.seen.advisor).toHaveLength(1);

      await d.chats.releaseMove(AGENT, s.chatId);
      await s.settled(d);
      expect(await d.chats.heldMoves()).toEqual([]);
      expect((await s.ledger(d)).map((c) => c.state)).toEqual(["answered", "answered"]);
    } finally {
      await s.cleanup();
    }
  });

  test("a held move whose consult ended while loki was closed is ready at the next start", async () => {
    const s = await consultSetup();
    try {
      const held = gate();
      s.replies.advisor = async () => (await held.wait, fauxAssistantMessage("answered before the restart"));
      await s.first.chats.consult({ agent_id: AGENT, conversation_id: s.chatId }, "agent", "look at a.ts");
      await until(() => s.seen.advisor.length === 1);
      expect(await s.first.chats.holdMove(AGENT, s.chatId, MINI)).toBe(true);
      s.replies.advisor = () => fauxAssistantMessage("answered after the restart");
      const closing = s.first.stores.closeAll();
      held.open();
      await closing;
      const after = await s.daemon();
      try {
        await after.consults.start();
        await until(async () => (await after.chats.heldMoves()).length === 1);
        expect(await after.chats.heldMoves()).toEqual([{ agent_id: AGENT, conversation_id: s.chatId, to: MINI }]);
        expect((await s.answers(after)).map((row) => answerOf(row))).toMatchObject([{ state: "answered" }]);
      } finally {
        await after.stores.closeAll();
      }
    } finally {
      await s.cleanup();
    }
  });
});

describe("a chat with an advisor moving to another Mac", () => {
  test("asked while a consult runs, it waits and says so, then goes: both chats arrive, the queued consult runs there, and the old Mac hides both", async () => {
    const s = await consultSetup();
    const mini = await s.daemon({ apart: true });
    const macs = twoMacs(s.first.chats, mini.chats);
    try {
      const book = s.first;
      const held = gate();
      const advise = s.replies.advisor;
      s.replies.advisor = async (text) => (await held.wait, advise(text));
      const ref = { agent_id: AGENT, conversation_id: s.chatId };
      const advisorId = `advisor-${s.chatId}`;
      await book.chats.consult(ref, "agent", "first look");
      await book.chats.consult(ref, "person", "second look");
      await until(() => s.seen.advisor.length === 1);

      expect(await macs.book.offer(MINI, AGENT, s.chatId)).toBe("The chat moves to Mac mini when the advisor has answered.");
      expect(await mini.store.chat(s.chatId, ctx)).toBeUndefined();
      s.replies.advisor = advise;
      held.open();
      await until(async () => (await infoOf(book.store, s.chatId)).hidden);

      expect(await infoOf(mini.store, s.chatId)).toMatchObject({ hidden: false, placed: true });
      expect(await infoOf(mini.store, advisorId)).toMatchObject({ hidden: true, mode: "standard", advisor_for: s.chatId });
      const advisor = must(await mini.store.chat(advisorId, ctx), "the moved advisor");
      const agent = await advisor.agent(ctx);
      expect(agent.model).toMatchObject({ modelId: "advice" });
      expect(agent.tools.map((t) => t.name).sort()).toEqual([...ADVISOR_TOOLS].sort());

      await s.settled(mini);
      expect((await s.ledger(mini)).map((c) => c.state)).toEqual(["answered", "answered"]);
      expect(s.seen.advisor.map((text) => consultOf(text)?.text)).toEqual(["first look", "second look"]);
      expect(s.seen.advisorContexts[1]).toContain(JSON.stringify(ADVISOR_PROMPT).slice(1, -1));
      expect((await s.answers(mini)).map((row) => answerOf(row)?.asked)).toEqual(["first look", "second look"]);
      expect((await kinds(mini.store, advisorId)).slice(0, 2)).toEqual((await kinds(book.store, advisorId)).slice(0, 2));

      expect(await infoOf(book.store, advisorId)).toMatchObject({ hidden: true });
      expect(await infoOf(book.store, s.chatId)).toMatchObject({ hidden: true, move_to: null });
      expect((await s.ledger(book)).map((c) => c.state)).toEqual(["answered", "dropped"]);
      expect(await book.chats.heldMoves()).toEqual([]);
    } finally {
      macs.cleanup();
      await s.cleanup(mini);
    }
  });

  test("moved back, it lands over the copies it left, and the advisor keeps its whole history", async () => {
    const s = await consultSetup();
    const mini = await s.daemon({ apart: true });
    const macs = twoMacs(s.first.chats, mini.chats);
    try {
      const ref = { agent_id: AGENT, conversation_id: s.chatId };
      const advisorId = `advisor-${s.chatId}`;
      await s.first.chats.consult(ref, "agent", "first look");
      await s.settled(s.first);
      await until(async () => !(await s.first.chats.busy(AGENT, s.chatId)));
      expect(await macs.book.offer(MINI, AGENT, s.chatId)).toBeNull();
      await mini.chats.consult(ref, "agent", "on the mini");
      await s.settled(mini);
      await until(async () => !(await mini.chats.busy(AGENT, s.chatId)));
      expect(await macs.mini.offer(BOOK, AGENT, s.chatId)).toBeNull();
      expect(await infoOf(s.first.store, s.chatId)).toMatchObject({ hidden: false });
      expect(await kinds(s.first.store, advisorId)).toEqual(await kinds(mini.store, advisorId));
      const copies = (await s.first.store.chats(ctx)).filter((c) => c.advisor_for === s.chatId);
      expect(copies.map((c) => (c.id === advisorId ? "here" : c.id.startsWith(`${advisorId}~moved-`) ? "set aside" : c.id)).sort()).toEqual([
        "here",
        "set aside",
      ]);
    } finally {
      macs.cleanup();
      await s.cleanup(mini);
    }
  });
});
