// Run the loki mod outside Letta for smoke testing: bun scripts/harness.ts
// Control:  POST :41500/tool {name,args} | /event {name,event} | /quit
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer, type IncomingMessage } from "node:http";

type Handler = (...args: unknown[]) => unknown;
type Tool = { name: string; run: (ctx: { args: Record<string, unknown>; conversation: unknown }) => unknown };
type Command = { id: string };

// The fake letta below hands the mod session-style capabilities; serve anyway (mod/gate.ts).
process.env.LOKI_MOD_SERVE ??= "1";
const modUrl = pathToFileURL(fileURLToPath(new URL("../mod/boot.ts", import.meta.url))); // same path Letta takes (fileURLToPath: a URL's pathname is /C:/… on Windows)
modUrl.searchParams.set("v", String(Date.now()));
const mod = await import(modUrl.href);

const tools = new Map<string, Tool>();
const commands = new Map<string, Command>();
const events = new Map<string, Handler[]>();
const letta = {
  capabilities: { commands: true, tools: true, events: { turns: true, lifecycle: true } },
  tools: { register: (t: Tool) => (tools.set(t.name, t), () => tools.delete(t.name)) },
  commands: { register: (c: Command) => (commands.set(c.id, c), () => commands.delete(c.id)) },
  events: {
    on: (name: string, h: Handler) => {
      if (!events.has(name)) events.set(name, []);
      events.get(name)!.push(h);
      return () => {};
    },
  },
  diagnostics: { report: (d: { severity: string; message: string }) => console.error("[diag]", d.severity, d.message) },
};
const dispose: (() => void) | undefined = await mod.default(letta); // boot.ts activate is async

const conv = {
  id: process.env.HARNESS_CONV ?? "conv-harness-1",
  sendMessageStream: async () =>
    (async function* () {
      yield { message_type: "assistant_message", content: "harness reply" };
    })(),
  getHistory: async () => [],
};

const text = (req: IncomingMessage) =>
  new Promise<string>((r) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => r(b));
  });

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const body = await text(req);
  try {
    let out: unknown;
    if (url.pathname === "/tool") {
      const { name, args } = JSON.parse(body || "{}");
      const tool = tools.get(name);
      if (!tool) throw new Error(`no tool named ${name}`);
      out = await tool.run({ args: args ?? {}, conversation: conv });
    } else if (url.pathname === "/event") {
      const { name, event } = JSON.parse(body || "{}");
      const ev = { conversationId: conv.id, ...(event ?? {}) };
      const results: unknown[] = [];
      for (const h of events.get(name) ?? []) results.push(await h(ev, { conversation: conv }));
      out = { results, event: ev };
    } else if (url.pathname === "/quit") {
      dispose?.();
      res.end("bye");
      setTimeout(() => process.exit(0), 200);
      return;
    } else out = { tools: [...tools.keys()], commands: [...commands.keys()], events: [...events.keys()] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(typeof out === "string" ? out : JSON.stringify(out, null, 2));
  } catch (e) {
    res.writeHead(500);
    res.end(String((e as Error)?.stack ?? e));
  }
}).listen(41500, "127.0.0.1", () => console.error("harness: control on http://127.0.0.1:41500  (/tool /event /quit)"));
