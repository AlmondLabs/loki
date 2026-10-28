// A stand-in ACP agent for tests: just enough of the Agent Client Protocol over stdio (initialize, session/new,
// session/load, session/prompt, session/cancel, session/set_mode, session/set_config_option) to be a real agent to
// @agentclientprotocol/sdk. What it does with a prompt depends on the prompt's words:
//   "hello"   streams "Hi " then "there", reports usage and its cost so far
//   "write"   opens a call with no arguments yet (as Claude's adapter does), fills them in, and writes a file
//   "edit"    asks permission to edit a file, then edits it (a diff) or reports the edit refused
//   "plan"    reports a plan, then a reply
//   "wait"    streams a word and waits for session/cancel
//   "deaf"    streams a word and never answers, whatever loki sends
//   "crash"   exits mid-turn
//   "auth"    fails the prompt the way an agent that is not signed in does
//   "prompt?" answers with the system prompt and the first prompt's words it was given
//   "mode?"   answers with its current mode and model
//   "effort?" answers with its current model and effort
//   "signin"  asks the client to open an MCP server's sign-in page (a URL elicitation) and says how it was answered
//   "mcp?"    answers with the MCP servers its session opened with and the tools it may run without asking
// With FAKE_ACP_HANG_FIRST_SESSION set, its first session/new is never answered (it says so on stderr), as an agent
// stuck opening a session.
// Plain JavaScript, so a test starts it with `node` and nothing else.
import { createInterface } from "node:readline";

const sessions = new Map();
let nextSession = 1;
let nextRequest = 1;
const waiting = new Map();
const cancels = new Map();
let costSoFar = 0;

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
const say = (sessionId, text) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = `agent-${nextRequest++}`;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

const MODES = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Default" },
    { id: "plan", name: "Plan" },
  ],
};
const modelOption = (value) => ({
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: value,
  options: [
    { value: "default", name: "Default" },
    { value: "sonnet", name: "Sonnet" },
  ],
});

// Each model's effort levels, as Claude's adapter offers them: they change with the model, and "ultra" is a level
// loki has no word for.
const LEVELS = { default: ["low", "medium", "high"], sonnet: ["low", "high", "max", "ultra"] };
const effortOption = (s) => ({
  id: "effort",
  name: "Effort",
  category: "thought_level",
  type: "select",
  currentValue: s.effort,
  options: [{ value: "default", name: "Default" }, ...LEVELS[s.model].map((l) => ({ value: l, name: l }))],
});
const options = (s) => [modelOption(s.model), effortOption(s)];

function open(sessionId, params) {
  const prompt = params.systemPrompt?.content?.map((c) => c.text).join("\n") ?? null;
  const servers = (params.mcpServers ?? []).map((m) => `${m.name} ${m.url ?? m.command}`).join(", ") || "none";
  const allowed = params._meta?.claudeCode?.options?.allowedTools?.join(", ") || "none";
  const s = { mode: "default", model: "default", effort: "default", systemPrompt: prompt, firstPrompt: null, servers, allowed };
  sessions.set(sessionId, s);
  return { modes: { ...MODES }, configOptions: options(s) };
}

async function prompt(params) {
  const id = params.sessionId;
  const s = sessions.get(id);
  const text = params.prompt
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  s.firstPrompt ??= text;
  const usage = { inputTokens: 100, outputTokens: 20, cachedReadTokens: 50, cachedWriteTokens: 10, totalTokens: 180 };
  if (text.includes("crash")) {
    say(id, "about to stop");
    setTimeout(() => process.exit(3), 20);
    return new Promise(() => {});
  }
  if (text.includes("prompt?")) {
    say(id, `system: ${s.systemPrompt ?? "none"} | first: ${s.firstPrompt}`);
    return { stopReason: "end_turn" };
  }
  if (text.includes("signin")) {
    const answer = await ask("elicitation/create", {
      mode: "url",
      sessionId: id,
      message: "Authenticate with MCP server notion",
      url: "https://signin.example.com/authorize?state=1",
      elicitationId: "sign-in-1",
    });
    say(id, `sign-in ${answer.action}`);
    return { stopReason: "end_turn" };
  }
  if (text.includes("mcp?")) {
    say(id, `mcp: ${s.servers} | allowed: ${s.allowed}`);
    return { stopReason: "end_turn" };
  }
  if (text.includes("effort?")) {
    say(id, `model ${s.model}, effort ${s.effort}`);
    return { stopReason: "end_turn" };
  }
  if (text.includes("mode?")) {
    say(id, `mode ${s.mode}, model ${s.model}`);
    return { stopReason: "end_turn" };
  }
  if (text.includes("deaf")) {
    say(id, "working");
    return new Promise(() => {});
  }
  if (text.includes("wait")) {
    say(id, "working");
    return new Promise((resolve) => cancels.set(id, () => resolve({ stopReason: "cancelled" })));
  }
  if (text.includes("write")) {
    update(id, { sessionUpdate: "tool_call", toolCallId: "call-w", title: "Preparing file…", kind: "edit", status: "pending" });
    update(id, { sessionUpdate: "tool_call_update", toolCallId: "call-w", title: "Write a.txt", rawInput: { path: "a.txt", content: "a\n" } });
    update(id, {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-w",
      status: "completed",
      content: [{ type: "diff", path: "a.txt", oldText: null, newText: "a\n" }],
    });
    say(id, "written");
    return { stopReason: "end_turn" };
  }
  if (text.includes("plan")) {
    update(id, {
      sessionUpdate: "plan",
      entries: [
        { content: "read the file", priority: "high", status: "completed" },
        { content: "change it", priority: "high", status: "pending" },
      ],
    });
    say(id, "planned");
    return { stopReason: "end_turn" };
  }
  if (text.includes("edit")) {
    say(id, "Let me edit it.");
    const toolCall = { toolCallId: "call-1", title: "Edit notes.txt", kind: "edit", status: "pending", rawInput: { path: "notes.txt" } };
    update(id, { sessionUpdate: "tool_call", ...toolCall });
    const answer = await ask("session/request_permission", {
      sessionId: id,
      toolCall,
      options: [
        { optionId: "yes", name: "Allow", kind: "allow_once" },
        { optionId: "always", name: "Always allow", kind: "allow_always" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
    });
    const allowed = answer.outcome?.outcome === "selected" && answer.outcome.optionId !== "no";
    if (allowed) {
      update(id, {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        content: [{ type: "diff", path: "notes.txt", oldText: "old", newText: "new" }],
      });
      say(id, `edited (${answer.outcome.optionId})`);
    } else {
      update(id, { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "failed", rawOutput: "refused" });
      say(id, answer.outcome?.outcome === "cancelled" ? "cancelled" : "not edited");
    }
    return { stopReason: answer.outcome?.outcome === "cancelled" ? "cancelled" : "end_turn" };
  }
  say(id, "Hi ");
  say(id, "there");
  costSoFar += 0.25;
  update(id, {
    sessionUpdate: "usage_update",
    used: 180,
    size: 200000,
    cost: { amount: costSoFar, currency: "USD" },
    _meta: { "_claude/model": "fake-sonnet" },
  });
  return { stopReason: "end_turn", usage };
}

async function handle(msg) {
  if (msg.id !== undefined && msg.method === undefined) {
    waiting.get(msg.id)?.(msg.result ?? {});
    waiting.delete(msg.id);
    return;
  }
  const ok = (result) => send({ id: msg.id, result });
  const p = msg.params ?? {};
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true },
          mcpCapabilities: process.env.FAKE_ACP_NO_HTTP_MCP ? {} : { http: true },
          sessionCapabilities: process.env.FAKE_ACP_NO_SYSTEM_PROMPT ? {} : { systemPrompt: { mode: { append: {} } } },
        },
        agentInfo: { name: "fake-acp", version: "1" },
        authMethods: [],
      });
    case "session/new": {
      if (process.env.FAKE_ACP_HANG_FIRST_SESSION && nextSession === 1) {
        nextSession++;
        process.stderr.write("fake-acp: holding the first session\n");
        return;
      }
      const sessionId = `s-${process.pid}-${nextSession++}`;
      ok({ sessionId, ...open(sessionId, p) });
      // Its commands follow the session, as Claude's adapter sends them.
      update(sessionId, {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "review", description: "review the changes", input: { hint: "[branch]" } }],
      });
      return;
    }
    case "session/load": {
      if (p.sessionId === "gone") return send({ id: msg.id, error: { code: -32002, message: "no such session" } });
      // The agent replays the session's history, which a client that keeps its own copy drops.
      update(p.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "replayed question" } });
      update(p.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "replayed answer" } });
      return ok(open(p.sessionId, p));
    }
    case "session/prompt":
      if (p.prompt.some((b) => b.type === "text" && b.text.includes("auth")))
        return send({ id: msg.id, error: { code: -32000, message: "Authentication required" } });
      return ok(await prompt(p));
    case "session/cancel":
      cancels.get(p.sessionId)?.();
      cancels.delete(p.sessionId);
      return;
    case "session/set_mode":
      sessions.get(p.sessionId).mode = p.modeId;
      update(p.sessionId, { sessionUpdate: "current_mode_update", currentModeId: p.modeId });
      return ok({});
    case "session/set_config_option": {
      const s = sessions.get(p.sessionId);
      // A new model starts on its default effort, as Claude's adapter does.
      if (p.configId === "model") Object.assign(s, { model: p.value, effort: "default" });
      else s.effort = p.value;
      return ok({ configOptions: options(s) });
    }
    default:
      if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: `no method ${msg.method}` } });
  }
}

process.stderr.write("fake-acp: ready\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim()) void handle(JSON.parse(line));
});
