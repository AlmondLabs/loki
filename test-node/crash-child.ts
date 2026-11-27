import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxToolCall, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AgentStore } from "../daemon/kernel/index.ts";
import { trialRegistry } from "./trial-registry.ts";

const [file, phase] = process.argv.slice(2);
const ctx = BACKGROUND_CONTEXT;
const faux = fauxProvider({ tokensPerSecond: 20, tokenSize: { min: 1, max: 2 } });
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: faux.provider.id, modelId: faux.getModel().id };

if (phase === "tool") faux.setResponses([fauxAssistantMessage(fauxToolCall("slow", { ms: 5_000 }), { stopReason: "toolUse" })]);
else faux.setResponses([fauxAssistantMessage("a long answer that streams slowly ".repeat(50))]);

const store = await AgentStore.open({ file }, { models, registry: trialRegistry(), settings: () => ({ progress: { persistWithinMs: 0 } }) }, ctx);
const chat = await store.createChat("c", { agent: { model } }, ctx);
let signaled = false;
if (phase === "generation") {
  store.harness.observeCommits({
    advance: (publication) => {
      if (signaled) return;
      for (const change of publication.changes) {
        if (change.type !== "document" || change.kind !== "change" || change.record.kind !== "pi.live") continue;
        const live = change.value as { generation?: { message?: { content?: Array<{ text?: string }> } } };
        if ((live.generation?.message?.content?.[0]?.text ?? "").length > 40) {
          signaled = true;
          process.stdout.write("under-way\n");
        }
      }
    },
    end: () => {},
  });
}
await chat.submit({ type: "input", content: "go", requestId: "r1" }, ctx);
