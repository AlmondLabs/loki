// Run the loci mod outside Letta for smoke testing: node scripts/harness.mjs
// Control:  POST :41500/canvas | /tool {name,args} | /event {name,event} | /quit
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";

/**
 * The mod starts Vite detached so it outlives /reload in Letta. For the harness
 * that leaves an orphan on LOCI_APP_PORT whose proxy points at a dead mod (a tab
 * on it shows "disconnected" forever), so /quit takes it down. Only the
 * harness's own port is touched, never Desktop's default 5173.
 */
function stopOwnVite() {
  const port = process.env.LOCI_APP_PORT;
  if (!port || port === "5173") return;
  try {
    const out = execFileSync("/usr/sbin/lsof", ["-nP", "-tiTCP:" + port, "-sTCP:LISTEN"], { encoding: "utf8" });
    for (const pid of out.split("\n").filter(Boolean)) process.kill(Number(pid), "SIGTERM");
  } catch {
    // nothing listening
  }
}

process.env.LOCI_NO_OPEN ??= "1";
const modUrl = pathToFileURL(new URL("../mod/boot.ts", import.meta.url).pathname); // same path Letta takes
modUrl.searchParams.set("v", String(Date.now()));
const mod = await import(modUrl.href);

const tools = new Map();
const commands = new Map();
const events = new Map();
const letta = {
  capabilities: { commands: true, tools: true, events: { turns: true, lifecycle: true } },
  tools: { register: (t) => (tools.set(t.name, t), () => tools.delete(t.name)) },
  commands: { register: (c) => (commands.set(c.id, c), () => commands.delete(c.id)) },
  events: {
    on: (name, h) => {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(h);
      return () => {};
    },
  },
  diagnostics: { report: (d) => console.error("[diag]", d.severity, d.message) },
};
const dispose = await mod.default(letta); // boot.ts activate is async

const conv = {
  id: process.env.HARNESS_CONV ?? "conv-harness-1",
  sendMessageStream: async () =>
    (async function* () {
      yield { message_type: "assistant_message", content: "harness reply" };
    })(),
  getHistory: async () => [],
};

const text = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const body = await text(req);
  try {
    let out;
    if (url.pathname === "/canvas") out = await commands.get("canvas").run({ conversation: conv, agent: process.env.HARNESS_AGENT ? { id: process.env.HARNESS_AGENT } : undefined });
    else if (url.pathname === "/tool") {
      const { name, args } = JSON.parse(body || "{}");
      out = await tools.get(name).run({ args: args ?? {}, conversation: conv });
    } else if (url.pathname === "/event") {
      const { name, event } = JSON.parse(body || "{}");
      const ev = { conversationId: conv.id, ...(event ?? {}) };
      const results = [];
      for (const h of events.get(name) ?? []) results.push(await h(ev, { conversation: conv }));
      out = { results, event: ev };
    } else if (url.pathname === "/quit") {
      dispose?.();
      stopOwnVite();
      res.end("bye");
      setTimeout(() => process.exit(0), 200);
      return;
    } else out = { tools: [...tools.keys()], commands: [...commands.keys()], events: [...events.keys()] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(typeof out === "string" ? out : JSON.stringify(out, null, 2));
  } catch (e) {
    res.writeHead(500);
    res.end(String(e?.stack ?? e));
  }
}).listen(41500, "127.0.0.1", () => console.error("harness: control on http://127.0.0.1:41500  (/canvas /tool /event /quit)"));
