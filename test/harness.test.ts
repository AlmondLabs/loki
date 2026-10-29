import { describe, expect, test } from "vitest";
import { decodeEntities, extractHarnessEvents, movedMark, ownText, stripHarnessMarkup, suggestedMark, suggestedOf } from "../core/harness.ts";

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
});

describe("the mod's desk block and a loaded skill are events, not the user's words", () => {
  test("desk activity becomes one event with the gestures as detail; older 'loci' builds are read too", () => {
    const text =
      'build a simple widget again\n\n<loci-desk desk="local-conv-1">\nCanvas activity since your last turn (the user\'s gestures on the loki desk):\n- moved "Weekly steps" (local-conv-1/bar-demo) to (1236, 154)\n- closed "loci" (shared/welcome) — the file still exists\nWidget files live under ~/.loki/widgets/local-conv-1/; call canvas_read for the full picture.\n</loci-desk>';
    expect(extractHarnessEvents(text)).toEqual([
      {
        text: "canvas activity",
        summary: "2 gestures on local-conv-1",
        detail: 'moved "Weekly steps" (local-conv-1/bar-demo) to (1236, 154)\nclosed "loci" (shared/welcome) — the file still exists',
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

describe("a chat's move mark (plan 023, addendum A5)", () => {
  test("is a quiet row naming both Macs, and no words in a bubble", () => {
    const mark = movedMark("Deepak's MacBook", 'Mac "mini"');
    expect(extractHarnessEvents(mark)).toEqual([{ text: 'moved to Mac "mini"', summary: "came over from Deepak's MacBook", detail: null }]);
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
