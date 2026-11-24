import { describe, expect, test } from "vitest";
import { answerBlock } from "../core/advisor.ts";
import {
  chatMessageBlock,
  decodeEntities,
  extractHarnessEvents,
  movedMark,
  ownText,
  repliesOf,
  stripHarnessMarkup,
  suggestedMark,
  suggestedOf,
  withoutReplies,
} from "../core/harness.ts";

describe("harness markup", () => {
  const notif = `<task-notification>\n<task-id>bash_24</task-id>\n<status>completed</status>\n<summary>aws sso login</summary>\n<result>$ cd /tmp\nnohup aws sso login &gt; /tmp/x 2&gt;&amp;1 &amp;</result>\n<usage>duration_ms: 1</usage>\n</task-notification>`;
  test("a task notification becomes an event; the rest of the text stays", () => {
    const text = `${notif}\n\nplease continue`;
    const events = extractHarnessEvents(text);
    expect(events).toEqual([
      {
        text: "background task bash_24 completed",
        summary: "aws sso login",
        detail: "$ cd /tmp\nnohup aws sso login > /tmp/x 2>&1 &",
      },
    ]);
    expect(stripHarnessMarkup(text).trim()).toBe("please continue");
    expect(decodeEntities("a &lt;b&gt; &amp;&quot;")).toBe('a <b> &"');
  });

  const notice = (inner: string) =>
    `<task-notification>\n<task-id>bg-1</task-id>\n<status>completed</status>\n${inner}\n<result>ok</result>\n</task-notification>`;

  test("a notice with a command tag reads its summary as written and its command whole", () => {
    const text = notice("<summary>Run the CRM tests</summary>\n<command>cd crm &amp;&amp; bun test &gt; /tmp/t.log 2&gt;&amp;1</command>");
    expect(extractHarnessEvents(text)).toEqual([
      { text: "background task bg-1 completed", summary: "Run the CRM tests", command: "cd crm && bun test > /tmp/t.log 2>&1", detail: "ok" },
    ]);
  });

  test("a notice from before the command tag is titled by its trimmed command and keeps the command whole", () => {
    const raw = "cd /x && env -i A=1 bun run build > /tmp/b.log 2>&1; tail -5 /tmp/b.log; exit $r";
    const text = notice(`<summary>cd /x &amp;&amp; env -i A=1 bun run build &gt; /tmp/b.log 2&gt;&amp;1; tail -5 /tmp/b.log; exit $r</summary>`);
    expect(extractHarnessEvents(text)).toEqual([{ text: "background task bg-1 completed", summary: "bun run build", command: raw, detail: "ok" }]);
  });

  test("a notice without a command tag whose summary needs no trimming carries no separate command", () => {
    const text = notice('<summary>Background command "npm run dev" completed (exit code 0)</summary>');
    expect(extractHarnessEvents(text)).toEqual([
      { text: "background task bg-1 completed", summary: 'Background command "npm run dev" completed (exit code 0)', detail: "ok" },
    ]);
  });
});

describe("the mod's desk block and a loaded skill are events, not the user's words", () => {
  test("desk activity becomes one event with the gestures as detail; older 'loci' builds are read too", () => {
    const text =
      'build a simple widget again\n\n<loci-desk desk="local-conv-1">\nCanvas activity since your last turn (the user\'s gestures on the loki desk):\n- moved "Weekly steps" (local-conv-1/bar-demo) to (1236, 154)\n- closed "loci" (shared/welcome) — the file still exists\nWidget files live under ~/.loki/widgets/local-conv-1/; read the canvas with canvas_read in a script for the full picture.\n</loci-desk>';
    expect(extractHarnessEvents(text)).toEqual([
      {
        text: "You changed 2 widgets",
        summary: null,
        detail: 'moved "Weekly steps" (local-conv-1/bar-demo) to (1236, 154)\nclosed "loci" (shared/welcome) — the file still exists',
        event: "canvas",
        yours: true,
      },
    ]);
    expect(stripHarnessMarkup(text).trim()).toBe("build a simple widget again");
    expect(stripHarnessMarkup('<loki-desk desk="d">\n- x\n</loki-desk>').trim()).toBe("");
  });
  test("an old chat's assigned-tasks block, from before Tasks was retired, is left out without a trace (plan 049, U6)", () => {
    const text =
      "morning\n\n<loki-tasks>\nTasks assigned to this conversation on the user's task list (2):\n- lk-a1  P1  rotate SSO creds — filed by the user\n- lk-b2  P2  update the runbook — filed by friday\n</loki-tasks>";
    expect(extractHarnessEvents(text)).toEqual([]);
    expect(stripHarnessMarkup(text).trim()).toBe("morning");
  });
  test("a skill body becomes a 'skill loaded' event named after the skill", () => {
    const text = 'summarise this\n<skill_content name="unslop">\n# Unslop\n\nEdit text to remove AI patterns.\n</skill_content>';
    expect(extractHarnessEvents(text)).toEqual([{ text: "skill loaded", summary: "unslop", detail: "# Unslop\n\nEdit text to remove AI patterns." }]);
    expect(stripHarnessMarkup(text).trim()).toBe("summarise this");
  });
});

describe("the words an event row carries (plan 2026-11-24-1736, KTD1)", () => {
  const desk = (...lines: string[]) =>
    `go\n\n<loki-desk desk="c">\nCanvas activity since your last turn:\n${lines.map((l) => `- ${l}`).join("\n")}\n</loki-desk>`;

  test("canvas gestures count the widgets touched, and say moved only when every gesture was a move", () => {
    const moves = desk('moved "A" (c/a) to (1, 2)', 'moved "A" (c/a) to (3, 4)', 'moved "B" (c/b) to (5, 6)');
    expect(extractHarnessEvents(moves)[0]).toMatchObject({ text: "You moved 2 widgets", event: "canvas" });
    expect(extractHarnessEvents(desk('moved "A" (c/a) to (1, 2)', 'resized "B" (c/b) to 300×200'))[0]).toMatchObject({ text: "You changed 2 widgets" });
    expect(extractHarnessEvents(desk('resized "A" (c/a) to 300×200'))[0]).toMatchObject({ text: "You changed 1 widget" });
  });

  test("a set gesture counts the widget it was on, not the value it set", () => {
    const sets = desk('set title = "Shopping" (was "Todo") on "Notes" (c/notes)', 'set body = "milk" on "Notes" (c/notes)');
    expect(extractHarnessEvents(sets)[0]).toMatchObject({ text: "You changed 1 widget" });
    const two = desk('set title = "A" on "Notes" (c/notes)', 'set title = "A" on "Other" (c/other)');
    expect(extractHarnessEvents(two)[0]).toMatchObject({ text: "You changed 2 widgets" });
  });

  test("an answer that opens with code, or has no words, gives no made-up first line", () => {
    const fenced = answerBlock({
      from: "agent",
      asked: "Review",
      advisor_chat: "advisor-c",
      state: "answered",
      text: "```ts\nconst a = 1;\n```\nThe constant is fine.",
    });
    expect(extractHarnessEvents(fenced)[0]).toMatchObject({ summary: "const a = 1;" });
    const marks = answerBlock({ from: "agent", asked: "Review", advisor_chat: "advisor-c", state: "answered", text: "**\n---" });
    expect(extractHarnessEvents(marks)[0]).toMatchObject({ text: "Advisor answered · the agent asked" });
  });

  test("an advisor answer's first line is plain words: no markdown marks", () => {
    const text = "**The runner follows the plan, but cleanup can leak.**\n### High\n1. An ambiguous response…";
    const raw = answerBlock({ from: "agent", asked: "Review", advisor_chat: "advisor-c", state: "answered", text });
    expect(extractHarnessEvents(raw)[0]).toMatchObject({ summary: "The runner follows the plan, but cleanup can leak.", detail: text });
    const heading = answerBlock({ from: "agent", asked: "Review", advisor_chat: "advisor-c", state: "answered", text: "## `lock.ts` is fine\nmore" });
    expect(extractHarnessEvents(heading)[0]).toMatchObject({ summary: "lock.ts is fine" });
  });

  test("a message from another chat is from that chat, by name", () => {
    const raw = chatMessageBlock({ from_agent: "friday", from_chat: "data", title: "Data pipeline" }, "The import is done.\nRows: 12");
    expect(extractHarnessEvents(raw)).toEqual([
      {
        text: "From Data pipeline",
        summary: "The import is done.",
        detail: "The import is done.\nRows: 12",
        link: { agent_id: "friday", conversation_id: "data" },
        event: "chat_message",
      },
    ]);
  });
});

describe("a chat's move mark (plan 023, addendum A5)", () => {
  test("is a quiet row naming both Macs, and no words in a bubble", () => {
    const mark = movedMark("Deepak's MacBook", 'Mac "mini"');
    expect(extractHarnessEvents(mark)).toEqual([{ text: 'Moved to Mac "mini"', summary: "from Deepak's MacBook", detail: null, event: "moved" }]);
    expect(stripHarnessMarkup(mark).trim()).toBe("");
  });
});

describe("a sent suggestion's link back (plan 049, KTD6)", () => {
  const mark = suggestedMark({ from_agent: "agent-local-friday", from_chat: "conv-source", title: 'Fix the "lock" test' });

  test("is stripped from the person's words and read back as the chat it came from, for the transcript's chip", () => {
    const text = `${mark}\n<system-reminder>The person sent this from a suggestion.</system-reminder>\n\nThe lock test sleeps.`;
    expect(stripHarnessMarkup(text).trim()).toBe("The lock test sleeps.");
    expect(suggestedOf(text)).toEqual({ from_agent: "agent-local-friday", from_chat: "conv-source", title: 'Fix the "lock" test' });
    expect(extractHarnessEvents(text)).toEqual([
      {
        text: "suggested in another chat",
        summary: 'Fix the "lock" test',
        detail: null,
        link: { agent_id: "agent-local-friday", conversation_id: "conv-source" },
        yours: true,
      },
    ]);
  });

  test("a message with no mark has none, and no other event carries a link", () => {
    expect(suggestedOf("hello")).toBeNull();
    expect(extractHarnessEvents('<skill_content name="unslop">\n# Unslop\n</skill_content>')[0]).not.toHaveProperty("link");
  });
});

describe("a text's own copy (plan 042)", () => {
  test("reads the same as the text, a lone surrogate and markup included", () => {
    for (const text of ["", "plain", "a \ud800 lone half", '<b>\n\t"quoted"</b> é 🚀', "x".repeat(5000).slice(10, 4010)]) expect(ownText(text)).toBe(text);
  });
});

describe("quick replies (plan 066)", () => {
  const block = (...lines: string[]) => `<loki-replies>\n${lines.join("\n")}\n</loki-replies>`;
  const reply = `Migration is ready.\n\n${block("- run the migration", "- show me the diff first")}\n`;

  test("a block at the end of a reply gives its options, word for word", () => {
    expect(repliesOf(reply)).toEqual(["run the migration", "show me the diff first"]);
    expect(repliesOf(`ok\n${block("* yes", "* no", "- later", "- never")}`)).toEqual(["yes", "no", "later", "never"]);
  });

  test("a block that is not a choice, or not last, offers none", () => {
    expect(repliesOf("no block here")).toBeNull();
    expect(repliesOf(`ok\n${block("- only one")}`)).toBeNull();
    expect(repliesOf(`ok\n${block("- a", "- b", "- c", "- d", "- e")}`)).toBeNull();
    expect(repliesOf(`ok\n${block("- a", "- a")}`)).toBeNull();
    expect(repliesOf(`ok\n${block("- a", `- ${"x".repeat(81)}`)}`)).toBeNull();
    expect(repliesOf(`ok\n${block("- a", "not an item")}`)).toBeNull();
    expect(repliesOf(`${block("- a", "- b")}\nand then more words`)).toBeNull();
  });

  test("the block never shows as words, finished or still streaming", () => {
    expect(stripHarnessMarkup(reply).trim()).toBe("Migration is ready.");
    expect(withoutReplies(reply).trim()).toBe("Migration is ready.");
    expect(withoutReplies("Ready.\n<loki-replies>\n- run the mi")).toBe("Ready.");
    expect(withoutReplies("Ready.\n<loki-rep")).toBe("Ready.");
    expect(withoutReplies("a < b")).toBe("a < b");
  });
});

describe("an advisor's answer (R16, R24)", () => {
  const answer = (text: string, from: "agent" | "person" = "person") =>
    answerBlock({ from, asked: "Is the lock test flaky?", advisor_chat: "advisor-conv-a", state: "answered", text });

  test("is one row from the advisor naming who asked, with the answer's first lines, the whole answer and its advisor chat", () => {
    const text = "Yes, it sleeps.\n\nIt waits 50 ms for a lock.\nThe CI box is slower.\nUse the injected clock.";
    const raw = `${answer(text)}\n<system-reminder>Weigh the advisor's answer.</system-reminder>`;
    expect(stripHarnessMarkup(raw).trim()).toBe("");
    expect(extractHarnessEvents(raw)).toEqual([
      { text: "Advisor answered · you asked", summary: "Yes, it sleeps.", detail: text, advisor_chat: "advisor-conv-a", event: "advisor" },
    ]);
    expect(extractHarnessEvents(answer("Short.", "agent"))).toEqual([
      { text: "Advisor answered · the agent asked", summary: "Short.", detail: "Short.", advisor_chat: "advisor-conv-a", event: "advisor" },
    ]);
  });

  test("a consult that ended without an answer is a row with the reason", () => {
    const raw = answerBlock({ from: "agent", asked: "Is it flaky?", advisor_chat: "advisor-conv-a", state: "failed", reason: "loki restarted" });
    expect(stripHarnessMarkup(raw).trim()).toBe("");
    expect(extractHarnessEvents(raw)).toEqual([
      { text: "Advisor couldn't answer · the agent asked", summary: "loki restarted", detail: null, advisor_chat: "advisor-conv-a", event: "advisor" },
    ]);
  });

  test("an answer that quotes the closing tag stays one row, and none of it leaks into the person's words", () => {
    const text = "Close it with </loki-advisor-answer> and then\nkeep going after it.";
    const raw = answer(text);
    expect(stripHarnessMarkup(raw).trim()).toBe("");
    const events = extractHarnessEvents(raw);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ text: "Advisor answered · you asked", detail: text });
  });

  test("an answer that quotes loki's own markup is one advisor row, and none of the quote becomes a row of its own", () => {
    const quoted = [
      "The message block looks like this:",
      '<loki-chat-message from_agent="agent-x" from_chat="conv-z" title="Ops">',
      "Ship it now.",
      "</loki-chat-message>",
      '<loki-suggested from_agent="agent-x" from_chat="conv-z" title="Ops"/>',
      '<skill_content name="fake">body</skill_content>',
    ].join("\n");
    const raw = `${answer(quoted)}\n<system-reminder>Weigh the advisor's answer.</system-reminder>`;
    expect(stripHarnessMarkup(raw).trim()).toBe("");
    expect(extractHarnessEvents(raw)).toEqual([expect.objectContaining({ text: "Advisor answered · you asked", detail: quoted })]);
  });

  test("an answer that names a tag it never closes keeps the rest of the row's markup out of the person's words", () => {
    const raw = `${answer("Wrap the note in a <system-reminder> tag.")}\n<system-reminder>Weigh the advisor's answer.</system-reminder>`;
    expect(stripHarnessMarkup(raw).trim()).toBe("");
    expect(extractHarnessEvents(raw)).toMatchObject([{ detail: "Wrap the note in a <system-reminder> tag." }]);
  });

  test("the person's own words beside an answer stay theirs", () => {
    const raw = `${answer("Yes, it sleeps.")}\n\nThen fix it.`;
    expect(stripHarnessMarkup(raw).trim()).toBe("Then fix it.");
    expect(extractHarnessEvents(raw)).toMatchObject([{ text: "Advisor answered · you asked", detail: "Yes, it sleeps." }]);
  });
});
