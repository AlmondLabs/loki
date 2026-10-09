import { describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { AgentStore } from "../daemon/kernel/index.ts";
import { parseResults, webSearchExtension } from "../daemon/web-search.ts";

/** DuckDuckGo's HTML results, in the shape its page has (an ad first, then two results, one through its redirect). */
const PAGE = `
<div class="result results_links results_links_deep result--ad ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=x">Buy now</a></h2>
  <a class="result__snippet" href="#">An advert</a>
</div>
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://earendil.com/posts/pi-durable/">Pi Durable | Earendil</a></h2>
  <a class="result__snippet" href="https://earendil.com/posts/pi-durable/">A <b>durable</b> harness &amp; more</a>
</div>
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fearendil-works%2Fpi&amp;rut=abc">earendil-works/pi</a></h2>
  <a class="result__snippet" href="#">AI agent toolkit</a>
</div>`;

describe("web search", () => {
  test("a results page reads as titles, real links and plain snippets, ads left out", () => {
    expect(parseResults(PAGE)).toEqual([
      { title: "Pi Durable | Earendil", url: "https://earendil.com/posts/pi-durable/", snippet: "A durable harness & more" },
      { title: "earendil-works/pi", url: "https://github.com/earendil-works/pi", snippet: "AI agent toolkit" },
    ]);
    expect(parseResults(PAGE, 1)).toHaveLength(1);
    expect(parseResults("<html>nothing</html>")).toEqual([]);
  });

  test("the tool hands the model numbered results, or says there were none", async () => {
    const ctx = BACKGROUND_CONTEXT;
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(webSearchExtension(async (q) => (q === "pi" ? parseResults(PAGE) : [])));
    const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry }, ctx);
    const chat = await store.createChat("c", { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } } }, ctx);
    faux.setResponses([fauxAssistantMessage([fauxToolCall("web_search", { query: "pi" }), fauxToolCall("web_search", { query: "zzz" })], { stopReason: "toolUse" }), fauxAssistantMessage("found it")]);
    await (await chat.submit({ type: "input", content: "search" }, ctx)).wait(ctx);
    const results = (await store.entries(chat, ctx)).filter((e) => e.kind === "pi.tool-result").map((e) => JSON.stringify(e.model));
    expect(results[0]).toContain("1. Pi Durable | Earendil\\n   https://earendil.com/posts/pi-durable/");
    expect(results[1]).toContain("No results from duckduckgo for: zzz");
    await store.close(ctx);
  });
});
