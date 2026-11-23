import { describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { ModRegistry } from "../daemon/mods/registry.ts";
import { CONSULTING_PROMPT, consultingSection } from "../mod/advisor.ts";
import { isPassChat } from "../mod/recall-worker.ts";
import { AGENT, advisorSetup } from "./fixtures/advisor.ts";
import { must } from "./fixtures/must.ts";

const ctx = BACKGROUND_CONTEXT;

const sent = (text: string) => JSON.stringify(text).slice(1, -1);

async function consultingMod() {
  const mods = new ModRegistry(() => {});
  await mods.load({ name: "loki", apiVersion: 1, activate: (api) => void consultingSection(api, isPassChat) });
  return mods;
}

describe("the consulting section", () => {
  test("it says when to consult, what to send, that the answer comes later, the cap, and that Nothing new ends a loop", () => {
    for (const words of [
      "before a risky or hard-to-undo step",
      "absolute paths",
      "Leave out your own reasoning",
      "never wait or check for it",
      "6 times an hour",
      '"Nothing new."',
    ])
      expect(CONSULTING_PROMPT).toContain(words);
  });

  test("an ACP chat's prompt gets it, and neither an advisor chat nor a background pass does", async () => {
    const mods = await consultingMod();
    const render = (chatId: string) => mods.renderSections({ chatId, agentId: AGENT, agentName: "Ada", cwd: undefined });
    expect(await render("local-conv-work")).toEqual([`<advisor_consult>\n${CONSULTING_PROMPT}\n</advisor_consult>`]);
    expect(await render("advisor-local-conv-work")).toEqual([]);
    expect(await render("reflection-agent-local-advised")).toEqual([]);
  });

  test("on loki's engine it is in a normal chat's prompt and not in its advisor's", async () => {
    const s = await advisorSetup();
    try {
      const mods = await consultingMod();
      s.registry.install(must(mods.registry.snapshot().extension("loki"), "the mod's extension"));
      await s.store.createChat("c", { agent: { model: s.model, cwd: s.folder } }, ctx);
      const prompts: string[] = [];
      const answer = (c: unknown) => (prompts.push(JSON.stringify(c)), fauxAssistantMessage("Nothing new."));
      s.faux.setResponses([answer, answer]);
      const opened = await s.advisors.open(AGENT, "c");
      if ("refused" in opened) throw new Error(opened.refused);
      await (await opened.chat.submit({ type: "input", content: "look at a.ts" }, ctx)).wait(ctx);
      await (await must(await s.store.chat("c", ctx), "the chat").submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
      const [advisor, normal] = prompts;
      expect(normal).toContain(sent(CONSULTING_PROMPT));
      expect(advisor).not.toContain(sent(CONSULTING_PROMPT));
    } finally {
      await s.cleanup();
    }
  });
});
