/**
 * A daemon stand-in that is killed mid-turn: it opens an agent store on SQLite, starts a turn, and reports when the
 * turn is under way, so the parent test can SIGKILL it there. Run by test-node/resume.test.ts, never on its own.
 *
 * argv: <sqlite file> <"generation" | "tool">
 */
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

const store = await AgentStore.open({ file }, { models, registry: trialRegistry() }, ctx);
const chat = await store.createChat("c", { agent: { model } }, ctx);
await chat.submit({ type: "input", content: "go", requestId: "r1" }, ctx);
// A tool reports itself from inside its call (trial-registry.ts); a generation once some of its answer is committed.
if (phase === "generation") {
  const view = await chat.viewState(ctx);
  view.subscribe((value) => {
    const live = value.docs["pi.live"] as { generation?: { message?: { content?: Array<{ text?: string }> } } } | undefined;
    if ((live?.generation?.message?.content?.[0]?.text ?? "").length > 40) process.stdout.write("under-way\n");
  });
}
