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
