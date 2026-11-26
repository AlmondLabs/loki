import { afterEach, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { AgentStore } from "../daemon/kernel/index.ts";
import { assertSafeUrl, htmlToText, parseResults, webFetch, webSearch, webSearchExtension } from "../daemon/web-search.ts";

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

  test("numeric entities decode, and one past Unicode on a malformed page stays as written instead of throwing", () => {
    const page = `<div class="result results_links"><h2><a class="result__a" href="https://x.example/">caf&#233; &#x2014; ok &#99999999; &#xFFFFFFF;</a></h2><a class="result__snippet">s</a></div>`;
    expect(parseResults(page)[0].title).toBe("café — ok &#99999999; &#xFFFFFFF;");
  });

  test("the tool hands the model numbered results, or says there were none", async () => {
    const ctx = BACKGROUND_CONTEXT;
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(webSearchExtension((q) => Promise.resolve(q === "pi" ? parseResults(PAGE) : [])));
    const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry }, ctx);
    const chat = await store.createChat("c", { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } } }, ctx);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("web_search", { query: "pi" }), fauxToolCall("web_search", { query: "zzz" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("found it"),
    ]);
    await (await chat.submit({ type: "input", content: "search" }, ctx)).wait(ctx);
    const results = (await store.entries(chat, ctx)).filter((e) => e.kind === "pi.tool-result").map((e) => JSON.stringify(e.model));
    expect(results[0]).toContain("1. Pi Durable | Earendil\\n   https://earendil.com/posts/pi-durable/");
    expect(results[1]).toContain("No results found for: zzz");
    await store.close(ctx);
  });

  test("htmlToText strips script/style and preserves readable blocks", () => {
    const text = htmlToText(
      "<html><head><style>body{color:red}</style></head><body><h1>Title</h1><p>Hello &amp; welcome.</p><script>alert(1)</script><ul><li>One</li><li>Two</li></ul></body></html>",
    );
    expect(text).toBe("Title\nHello & welcome.\n- One\n- Two");
  });

  test("assertSafeUrl blocks non-http(s), localhost, and private IPs while allowing public hosts", () => {
    expect(assertSafeUrl("https://example.com/docs").hostname).toBe("example.com");
    for (const bad of [
      "file:///etc/passwd",
      "http://localhost:8080/",
      "http://127.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://[::1]/",
    ])
      expect(() => assertSafeUrl(bad)).toThrow();
  });

  test("webFetch extracts text and enforces maxChars, and web_fetch fences fetched content", async () => {
    const out = await webFetch("https://example.com/post", {
      maxChars: 250,
      fetch: () =>
        Promise.resolve(
          new Response(`<article><p>${"x".repeat(400)}</p></article>`, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        ),
    });
    expect(out.truncated).toBe(true);
    expect(out.text).toHaveLength(250);

    const ctx = BACKGROUND_CONTEXT;
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(
      webSearchExtension(
        () => Promise.resolve([]),
        () => Promise.resolve({ url: "https://example.com/post", contentType: "text/html", text: "Hello from site", truncated: false }),
      ),
    );
    const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry }, ctx);
    const chat = await store.createChat("c", { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } } }, ctx);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("web_fetch", { url: "https://example.com/post" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("read it"),
    ]);
    await (await chat.submit({ type: "input", content: "fetch" }, ctx)).wait(ctx);
    const results = (await store.entries(chat, ctx)).filter((e) => e.kind === "pi.tool-result").map((e) => JSON.stringify(e.model));
    expect(results[0]).toContain("Hello from site");
    expect(results[0]).toContain("example.com");
    await store.close(ctx);
  });

  test("webSearch detects DuckDuckGo bot challenges with actionable error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(new Response('<div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>', { status: 200 }));
    try {
      await expect(webSearch("test")).rejects.toThrow(/BRAVE_API_KEY/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

afterEach(() => {
  delete process.env.BRAVE_API_KEY;
  delete process.env.TAVILY_API_KEY;
});
