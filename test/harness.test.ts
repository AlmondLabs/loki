import { describe, expect, test } from "bun:test";
import { decodeEntities, extractHarnessEvents, stripHarnessMarkup } from "../packages/core/src/harness.ts";

describe("harness markup", () => {
  const notif = `<task-notification>\n<task-id>bash_24</task-id>\n<status>completed</status>\n<summary>Background command "Re-auth dev" completed</summary>\n<result>$ cd /tmp\nnohup aws sso login &gt; /tmp/x 2&gt;&amp;1 &amp;</result>\n<usage>duration_ms: 1</usage>\n</task-notification>\nFull transcript available at: /var/x/bash_24.log`;
  test("task notifications and compaction alerts become events; the rest of the text stays", () => {
    const text = `${notif}\n\nplease continue`;
    const events = extractHarnessEvents(text);
    expect(events).toEqual([{ text: "background task bash_24 completed", summary: 'Background command "Re-auth dev" completed', detail: "$ cd /tmp\nnohup aws sso login > /tmp/x 2>&1 &" }]);
    expect(stripHarnessMarkup(text).trim()).toBe("please continue");
    const alert = extractHarnessEvents('{"type":"system_alert","message":"Note: 14 messages from the beginning of the conversation have been hidden from view due to memory constraints.\\nSummary…"}');
    expect(alert[0]).toMatchObject({ text: "context compacted" });
    expect(stripHarnessMarkup('{"type":"system_alert","message":"x"}').trim()).toBe("");
    expect(decodeEntities("a &lt;b&gt; &amp;&quot;")).toBe('a <b> &"');
  });
});

describe("the mod's desk block and a loaded skill are events, not the user's words", () => {
  test("desk activity becomes one event with the gestures as detail; older 'loci' builds are read too", () => {
    const text = 'build a simple widget again\n\n<loci-desk desk="local-conv-1">\nCanvas activity since your last turn (the user\'s gestures on the loki desk):\n- moved "Weekly steps" (local-conv-1/bar-demo) to (1236, 154)\n- closed "loci" (shared/welcome) — the file still exists\nWidget files live under ~/.letta/loki/widgets/local-conv-1/; call desk_state for the full picture.\n</loci-desk>';
    expect(extractHarnessEvents(text)).toEqual([{ text: "desk activity", summary: "2 gestures on local-conv-1", detail: 'moved "Weekly steps" (local-conv-1/bar-demo) to (1236, 154)\nclosed "loci" (shared/welcome) — the file still exists' }]);
    expect(stripHarnessMarkup(text).trim()).toBe("build a simple widget again");
    expect(stripHarnessMarkup('<loki-desk desk="d">\n- x\n</loki-desk>').trim()).toBe("");
  });
  test("a skill body becomes a 'skill loaded' event named after the skill", () => {
    const text = 'summarise this\n<skill_content name="unslop">\n# Unslop\n\nEdit text to remove AI patterns.\n</skill_content>';
    expect(extractHarnessEvents(text)).toEqual([{ text: "skill loaded", summary: "unslop", detail: "# Unslop\n\nEdit text to remove AI patterns." }]);
    expect(stripHarnessMarkup(text).trim()).toBe("summarise this");
  });
});
