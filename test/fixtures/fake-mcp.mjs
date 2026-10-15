// A stand-in MCP server for tests: just enough JSON-RPC (initialize, tools/list, tools/call, ping) to be a real
// server to @modelcontextprotocol/client. Run as a script it serves stdio; imported, `serve(transport)` answers on any
// transport (InMemoryTransport). Plain JavaScript, so a test can start it with `node` and nothing else.
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** The tools it offers: a reader, a writer, a big one, a failing one, and one that kills the process. */
export const TOOLS = [
  {
    name: "list_issues",
    description: "List the open issues of a repository",
    inputSchema: { type: "object", properties: { repo: { type: "string" }, state: { type: "string" } }, required: ["repo"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_issue",
    description: "Open a new issue in a repository",
    inputSchema: { type: "object", properties: { repo: { type: "string" }, title: { type: "string" } }, required: ["repo", "title"] },
  },
  {
    name: "delete_repo",
    description: "Delete a repository for good",
    inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
    annotations: { destructiveHint: true },
  },
  { name: "dump_logs", description: "Every log line of the last deploy", inputSchema: { type: "object", properties: {} } },
  { name: "always_fails", description: "A tool that reports an error", inputSchema: { type: "object", properties: {} } },
  { name: "crash", description: "Stops the server", inputSchema: { type: "object", properties: {} } },
];

/** What the server answers a request with; null for a notification, which gets no answer. */
export function answer(msg, opts = {}) {
  if (msg.id === undefined) return null;
  const ok = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "fake", version: "1.0.0", description: "A fake issue tracker for tests" },
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: opts.tools ?? TOOLS });
    case "tools/call": {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      if (name === "dump_logs") return ok({ content: [{ type: "text", text: "log line\n".repeat(8000) }] });
      if (name === "always_fails") return ok({ isError: true, content: [{ type: "text", text: "the tracker is read-only today" }] });
      if (name === "crash") {
        opts.onCrash?.();
        return null;
      }
      return ok({ content: [{ type: "text", text: `${name} ${JSON.stringify(args)}` }] });
    }
    default:
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `no method ${msg.method}` } };
  }
}

/** Answer on a transport (the server end of an InMemoryTransport pair). */
export async function serve(transport, opts = {}) {
  transport.onmessage = (msg) => {
    const reply = answer(msg, opts);
    if (reply) void transport.send(reply);
  };
  await transport.start();
  return transport;
}

// As a script: newline-delimited JSON-RPC on stdin and stdout, as MCP's stdio transport speaks it. "Run as a script"
// compares whole paths the system's way: a split on "/" never matched a Windows path, so there the server exited at once.
const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && same(resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  process.stderr.write("fake mcp server ready\n");
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    const reply = answer(JSON.parse(line), { onCrash: () => process.exit(3) });
    if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
  });
}
