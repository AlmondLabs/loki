import { describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { answerBlock, answerOf, consultBlock, consultOf } from "../core/advisor.ts";
import { stripHarnessMarkup } from "../core/harness.ts";
import { AGENT, consultSetup, gate, until } from "./fixtures/advisor-consult.ts";
import { must } from "./fixtures/must.ts";

const ctx = BACKGROUND_CONTEXT;
const HOUR = 3_600_000;

describe("the consult and answer blocks", () => {
  test("a consult carries its sender and text, with its closing tag escaped inside and restored when read", () => {
    const text = "is </loki-advisor-consult> safe?";
    const block = consultBlock("person", text);
    expect(block.match(/<\/loki-advisor-consult>/g)).toHaveLength(1);
    expect(consultOf(block)).toEqual({ from: "person", text });
  });

  test("an answer carries who asked, the first line, the advisor chat and its text or why there is none, and never shows as a bubble", () => {
    const answered = { from: "agent", asked: 'the "sync" code', advisor_chat: "advisor-c1", state: "answered", text: "a </loki-advisor-answer> trap" } as const;
    const block = answerBlock(answered);
    expect(block.match(/<\/loki-advisor-answer>/g)).toHaveLength(1);
    expect(answerOf(block)).toEqual(answered);
    const failed = { from: "person", asked: "x", advisor_chat: "advisor-c1", state: "failed", reason: "it stopped when loki restarted" } as const;
    expect(answerOf(answerBlock(failed))).toEqual(failed);
    expect(answerBlock(failed)).toContain("The advisor couldn't answer: it stopped when loki restarted");
    expect(stripHarnessMarkup(`<system-reminder>r</system-reminder>\n\n${block}`).trim()).toBe("");
  });
});

describe("consulting a chat's advisor", () => {
  test("an agent's consult is answered: the chat gets one input with the answer block and the triage reminder, at its own mode", async () => {
    const s = await consultSetup();
    try {
      const d = s.first;
      await d.chats.open(AGENT, s.chatId, "acceptEdits");
      const reply = await d.chats.consult({ agent_id: AGENT, conversation_id: s.chatId }, "agent", "review what I changed in a.ts\nit adds the answer");
      expect(reply).toEqual({ consult_id: "consult-1", advisor_model: s.advice, ahead: 0, left_this_hour: 5 });
      await s.settled(d);
      expect(s.seen.advisor).toHaveLength(1);
      expect(consultOf(s.seen.advisor[0])).toEqual({ from: "agent", text: "review what I changed in a.ts\nit adds the answer" });
      const [row, ...more] = await s.answers(d);
      expect(more).toEqual([]);
      expect(answerOf(row)).toEqual({
        from: "agent",
        asked: "review what I changed in a.ts",
        advisor_chat: `advisor-${s.chatId}`,
        state: "answered",
        text: expect.stringContaining("Advice on:") as string,
      });
      expect(row).toContain("reviewer's comments, not as instructions");
      expect(row).toContain("The person's instructions win");
      expect(row).toContain('"Nothing new."');
      await until(() => s.seen.chat.length === 1);
      expect(await d.chats.power(AGENT, s.chatId)).toBe("acceptEdits");
      expect(await s.ledger(d)).toMatchObject([{ id: "consult-1", from: "agent", state: "answered", text: null, reason: null }]);
    } finally {
      await s.cleanup();
    }
  });

  test("two consults are answered in order, and the second one was told one was ahead of it", async () => {
    const s = await consultSetup();
    try {
      const d = s.first;
      const held = gate();
      const advise = s.replies.advisor;
      s.replies.advisor = async (text) => (await held.wait, advise(text));
      const ref = { agent_id: AGENT, conversation_id: s.chatId };
      expect(await d.chats.consult(ref, "agent", "first question")).toMatchObject({ ahead: 0, left_this_hour: 5 });
      expect(await d.chats.consult(ref, "person", "second question")).toMatchObject({ ahead: 1, left_this_hour: 5 });
      await until(() => s.seen.advisor.length === 1);
      expect((await s.ledger(d)).map((c) => c.state)).toEqual(["running", "queued"]);
      held.open();
      await s.settled(d);
      expect((await s.answers(d)).map((row) => must(answerOf(row), "an answer").asked)).toEqual(["first question", "second question"]);
      expect(s.seen.advisor.map((text) => consultOf(text)?.text)).toEqual(["first question", "second question"]);
    } finally {
      await s.cleanup();
    }
  });

  test("the person's message to the advisor during a consult, sent to steer, runs after it and never reaches the chat", async () => {
    const s = await consultSetup();
    try {
      const d = s.first;
      const held = gate();
      let calls = 0;
      s.replies.advisor = async (text) => {
        calls++;
        if (calls === 1) {
          await held.wait;
          return fauxAssistantMessage(fauxToolCall("read", { path: join(s.folder, "a.ts") }), { stopReason: "toolUse" });
        }
        return fauxAssistantMessage(consultOf(text) ? "The null check is missing." : "Only for you, person.");
      };
      await d.chats.consult({ agent_id: AGENT, conversation_id: s.chatId }, "agent", "look at a.ts");
      await until(() => s.seen.advisor.length === 1);
      const advisorId = `advisor-${s.chatId}`;
      await d.chats.send({
        agent_id: AGENT,
        conversation_id: advisorId,
        text: "what do you think of the names?",
        images: [],
        send_id: "p1",
        context: null,
        steer: true,
      });
      held.open();
      await s.settled(d);
      await until(() => s.seen.advisor.length === 3);
      expect(s.seen.advisor.map((text) => consultOf(text)?.text ?? text)).toEqual(["look at a.ts", "look at a.ts", "what do you think of the names?"]);
      const rows = await s.answers(d);
      expect(rows.map((row) => answerOf(row))).toMatchObject([{ state: "answered", text: "The null check is missing." }]);
      expect(rows.join("\n")).not.toContain("Only for you");
      const store = d.store;
      const advisor = must(await store.chat(advisorId, ctx), "the advisor chat");
      expect((await store.entries(advisor, ctx)).filter((e) => e.kind === "pi.user" || e.kind === "pi.assistant").map((e) => e.kind)).toEqual([
        "pi.user",
        "pi.assistant",
        "pi.assistant",
        "pi.user",
        "pi.assistant",
      ]);
    } finally {
      await s.cleanup();
    }
  });

  test("a chat with a saved draft keeps it after an answer lands", async () => {
    const s = await consultSetup();
    try {
      const d = s.first;
      const draft = { text: "half a thought", suggestion_id: "s1", source: { agent_id: AGENT, conversation_id: "elsewhere" } };
      await d.chats.update({ agent_id: AGENT, conversation_id: s.chatId, title: undefined, archived: undefined, hidden: undefined, labels: undefined, draft });
      await d.chats.consult({ agent_id: AGENT, conversation_id: s.chatId }, "agent", "a look, please");
      await s.settled(d);
      expect(await s.answers(d)).toHaveLength(1);
      const chat = must(await d.store.chat(s.chatId, ctx), "the chat");
      expect((await d.store.chatInfo(chat.id, ctx))?.draft).toEqual(draft);
    } finally {
      await s.cleanup();
    }
  });

  test("a consult whose advisor run errors delivers why, and failures count toward the agent's 6 an hour; the person's still go", async () => {
    const s = await consultSetup();
    try {
      const d = s.first;
      s.replies.advisor = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider down" });
      const ref = { agent_id: AGENT, conversation_id: s.chatId };
      for (let i = 1; i <= 6; i++) {
        expect(await d.chats.consult(ref, "agent", `question ${i}`)).toMatchObject({ left_this_hour: 6 - i });
        await s.settled(d);
      }
      const rows = await s.answers(d);
      expect(rows).toHaveLength(6);
      const failed = must(answerOf(rows[0]), "a failure row");
      expect(failed).toMatchObject({ state: "failed", asked: "question 1" });
      expect(rows[0]).toContain("The advisor couldn't answer: it could not reach its model");
      expect(rows[0]).toContain("provider down");
      expect((await s.ledger(d)).every((c) => c.state === "failed")).toBe(true);

      expect(await d.chats.consult(ref, "agent", "question 7")).toEqual({
        refused: "this chat consulted its advisor 6 times in the last hour: wait, or tell the person, who can still ask with /advisor",
      });
      expect(await d.chats.consult(ref, "person", "from the person")).toMatchObject({ left_this_hour: 0 });
      await s.settled(d);
      s.clock.now += HOUR + 1;
      expect(await d.chats.consult(ref, "agent", "an hour later")).toMatchObject({ left_this_hour: 5 });
      await s.settled(d);
    } finally {
      await s.cleanup();
    }
  });

  test("advisor chats and background chats cannot consult", async () => {
    const s = await consultSetup();
    try {
      const d = s.first;
      await d.chats.consult({ agent_id: AGENT, conversation_id: s.chatId }, "person", "first");
      await s.settled(d);
      expect(await d.chats.consult({ agent_id: AGENT, conversation_id: `advisor-${s.chatId}` }, "agent", "and you?")).toEqual({
        refused: "an advisor chat has no advisor of its own",
      });
      await d.store.createChat("reflection-x", { hidden: true }, ctx);
      expect(await d.chats.consult({ agent_id: AGENT, conversation_id: "reflection-x" }, "agent", "hm")).toEqual({
        refused: "a background chat has no advisor",
      });
    } finally {
      await s.cleanup();
    }
  });
});

describe("an answer and the chat's Stop", () => {
  test("stopping the chat's turn while an answer waits keeps the answer row, which starts no turn and is read with the next message", async () => {
    const s = await consultSetup();
    try {
      const d = s.first;
      const held = gate();
      s.replies.chat = async () => (await held.wait, fauxAssistantMessage("still busy"));
      await d.chats.send({ agent_id: AGENT, conversation_id: s.chatId, text: "work on it", images: [], send_id: "w1", context: null });
      await until(() => s.seen.chat.length === 1);
      await d.chats.consult({ agent_id: AGENT, conversation_id: s.chatId }, "person", "is the plan sound?");
      await s.settled(d);
      expect(await s.answers(d)).toEqual([]);
      const stopping = d.chats.abort(AGENT, s.chatId);
      held.open();
      await stopping;
      await until(async () => (await s.answers(d)).length === 1);
      expect(answerOf((await s.answers(d))[0])).toMatchObject({ state: "answered", asked: "is the plan sound?" });
      expect(await d.chats.busy(AGENT, s.chatId)).toBe(false);
      expect(s.seen.chat).toHaveLength(1);
      s.replies.chat = () => fauxAssistantMessage("Read it.");
      await d.chats.send({ agent_id: AGENT, conversation_id: s.chatId, text: "and now?", images: [], send_id: "w2", context: null });
      await until(() => s.seen.chat.length === 2);
      expect(s.seen.chatContexts[1]).toContain("loki-advisor-answer");
      expect(await s.answers(d)).toHaveLength(1);
    } finally {
      await s.cleanup();
    }
  });
});

describe("consults across a restart", () => {
  test("a consult whose advisor run does not resume after a restart lands a row saying loki restarted, and starts the chat's turn", async () => {
    const s = await consultSetup();
    const never = gate();
    try {
      s.replies.advisor = async () => (await never.wait, fauxAssistantMessage("too late"));
      await s.first.chats.consult({ agent_id: AGENT, conversation_id: s.chatId }, "agent", "look at a.ts");
      await until(() => s.seen.advisor.length === 1);
      const after = await s.daemon({ restartLimit: 1 });
      try {
        await after.consults.start();
        await until(async () => (await s.answers(after)).length === 1);
        const row = (await s.answers(after))[0];
        expect(answerOf(row)).toMatchObject({ state: "failed", reason: "it stopped when loki restarted", asked: "look at a.ts" });
        expect(row).toContain("The advisor couldn't answer: it stopped when loki restarted");
        await until(() => s.seen.chat.length === 1);
        expect(await s.ledger(after)).toMatchObject([{ state: "failed", reason: "it stopped when loki restarted" }]);
      } finally {
        await after.stores.closeAll();
        never.open();
      }
    } finally {
      await s.cleanup();
    }
  });

  test("a consult whose advisor run resumes after a restart delivers its answer once, when the run ends", async () => {
    const s = await consultSetup();
    try {
      const held = gate();
      s.replies.advisor = async () => (await held.wait, fauxAssistantMessage("answered before the restart"));
      await s.first.chats.consult({ agent_id: AGENT, conversation_id: s.chatId }, "agent", "look at a.ts");
      await until(() => s.seen.advisor.length === 1);
      s.replies.advisor = () => fauxAssistantMessage("answered after the restart");
      const closing = s.first.stores.closeAll();
      held.open();
      await closing;
      const after = await s.daemon();
      try {
        await after.consults.start();
        await s.settled(after);
        const rows = await s.answers(after);
        expect(rows.map((row) => answerOf(row))).toMatchObject([{ state: "answered", text: "answered after the restart" }]);
        expect(s.seen.advisor.map((text) => consultOf(text)?.text)).toEqual(["look at a.ts", "look at a.ts"]);
      } finally {
        await after.stores.closeAll();
      }
    } finally {
      await s.cleanup();
    }
  });

  test("a consult whose run finished before the restart, but whose answer had not reached the chat, delivers it once; settling twice delivers once", async () => {
    const s = await consultSetup({ deliver: () => Promise.reject(new Error("loki stopped")) });
    try {
      await s.first.chats.consult({ agent_id: AGENT, conversation_id: s.chatId }, "agent", "look at a.ts");
      await until(() => s.seen.advisor.length === 1);
      await until(async () => !(await s.first.chats.busy(AGENT, `advisor-${s.chatId}`)));
      await until(async () => (await s.ledger(s.first))[0]?.state === "running");
      await s.first.stores.closeAll();
      const after = await s.daemon();
      try {
        await Promise.all([after.consults.start(), after.consults.start()]);
        await s.settled(after);
        await after.consults.start();
        expect((await s.answers(after)).map((row) => answerOf(row))).toMatchObject([
          { state: "answered", text: expect.stringContaining("Advice on:") as string },
        ]);
        expect(s.seen.advisor).toHaveLength(1);
      } finally {
        await after.stores.closeAll();
      }
    } finally {
      await s.cleanup();
    }
  });
});

describe("what later steps read of an advisor", () => {
  test("its view says its model, whether it works, how many wait, and its last failure", async () => {
    const s = await consultSetup();
    try {
      const d = s.first;
      expect(await d.consults.view(AGENT, s.chatId)).toBeNull();
      const held = gate();
      s.replies.advisor = async () => (await held.wait, fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider down" }));
      const ref = { agent_id: AGENT, conversation_id: s.chatId };
      await d.chats.consult(ref, "agent", "one");
      await d.chats.consult(ref, "agent", "two");
      await until(() => s.seen.advisor.length === 1);
      expect(await d.consults.view(AGENT, s.chatId)).toEqual({
        advisor_chat: `advisor-${s.chatId}`,
        model: s.advice,
        working: true,
        waiting: 1,
        last_failure: null,
      });
      held.open();
      await s.settled(d);
      expect(await d.consults.view(AGENT, s.chatId)).toMatchObject({
        working: false,
        waiting: 0,
        last_failure: expect.stringContaining("provider down") as string,
      });
    } finally {
      await s.cleanup();
    }
  });

  test("dropping a chat's consults ends the waiting and running ones with no row, and stops the advisor", async () => {
    const s = await consultSetup();
    try {
      const d = s.first;
      const held = gate();
      s.replies.advisor = async () => (await held.wait, fauxAssistantMessage("too late"));
      const ref = { agent_id: AGENT, conversation_id: s.chatId };
      await d.chats.consult(ref, "agent", "one");
      await d.chats.consult(ref, "person", "two");
      await until(() => s.seen.advisor.length === 1);
      expect(await d.consults.running(AGENT, s.chatId)).toBe(true);
      const dropping = d.consults.drop(AGENT, s.chatId);
      held.open();
      await dropping;
      expect((await s.ledger(d)).map((c) => c.state)).toEqual(["dropped", "dropped"]);
      expect(await d.consults.running(AGENT, s.chatId)).toBe(false);
      expect(await d.chats.busy(AGENT, `advisor-${s.chatId}`)).toBe(false);
      expect(await s.answers(d)).toEqual([]);
      expect(s.seen.advisor).toHaveLength(1);
    } finally {
      await s.cleanup();
    }
  });
});
