import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SubagentView } from "../core/subagents.ts";
import type { DeskChatModel } from "../app/src/workspace/use-workspace-chat.ts";
import { WorkersHeader, workersTabStatus } from "../app/src/chat/workers-header.tsx";
import { OpenWorker, SubagentEventRow } from "../app/src/chat/transcript.tsx";
import { paneTabs } from "../app/src/workspace/canvas-pane.tsx";
import { workerConversation, WorkersPanel } from "../app/src/workspace/workers-pane.tsx";

const kestrel: SubagentView = {
  id: "kestrel",
  chat_id: "c1~subagent~kestrel",
  name: "kestrel",
  description: "Inspect the cache layer",
  model: "anthropic/claude-haiku-4-5",
  status: "running",
  read_only: true,
  started_at: "2026-11-27T10:00:00.000Z",
};

const ember: SubagentView = {
  id: "ember",
  chat_id: "c1~subagent~ember",
  name: "ember",
  description: "Fix migration ordering",
  model: "openai/gpt-5.4",
  status: "error",
  branch: "loki-subagent/ember",
  started_at: "2026-11-27T10:01:00.000Z",
  error: "Tests failed in CI",
};

const atlas: SubagentView = {
  id: "atlas",
  chat_id: "c1~subagent~atlas",
  name: "atlas",
  description: "Audit auth routes",
  model: "openai/gpt-5.4-mini",
  status: "done",
  started_at: "2026-11-27T09:59:00.000Z",
};

describe("Workers UI helpers and views", () => {
  test("workersTabStatus and paneTabs reflect active, failed, and idle worker counts", () => {
    expect(paneTabs([])).toEqual([]);

    expect(workersTabStatus([kestrel])).toMatchObject({ words: "kestrel is working" });
    expect(workersTabStatus([kestrel, { ...ember, status: "running" }])).toMatchObject({ words: "2 workers active" });
    expect(workersTabStatus([ember])).toMatchObject({ words: "ember failed" });
    expect(workersTabStatus([atlas])).toBeNull();

    const tabs = paneTabs([kestrel, atlas]);
    expect(tabs.map((t) => [t.id, t.label, t.count])).toEqual([
      ["messages", "Messages", undefined],
      ["workers", "Workers", 2],
    ]);
  });

  test("WorkersHeader renders compact strip for running, failed, and completed workers", () => {
    const working = renderToStaticMarkup(createElement(WorkersHeader, { subagents: [kestrel, atlas] }));
    expect(working).toContain("kestrel is working");
    expect(working).toContain('data-state="working"');

    const failed = renderToStaticMarkup(createElement(WorkersHeader, { subagents: [ember, atlas] }));
    expect(failed).toContain("ember failed");
    expect(failed).toContain("Tests failed in CI");
    expect(failed).toContain('data-state="failed"');

    const idle = renderToStaticMarkup(createElement(WorkersHeader, { subagents: [atlas] }));
    expect(idle).toContain("atlas");
    expect(idle).toContain('data-state="idle"');
  });

  test("workerConversation derives model, error, and commands for a worker", () => {
    const chat: DeskChatModel = {
      deskRuntime: { agent_id: "agent-a", conversation_id: kestrel.chat_id },
      deskChat: null,
      pendingApproval: null,
      pendingQuestion: null,
    };
    const { view } = workerConversation(
      {
        status: "open",
        send: () => {},
        answer: () => {},
        decide: () => {},
        commands: [
          { id: "compact", description: "Compact", where: "harness" },
          { id: "reflect", description: "Reflect", where: "harness" },
        ],
        execute: () => Promise.resolve({ success: true, output: "" }),
        cancelQueued: () => {},
        stop: () => Promise.resolve(null),
      },
      chat,
      kestrel,
      { entries: null, model: null, reasoningEffort: "low" },
      [],
    );
    expect(view.status).toBe("thinking");
    expect(view.model).toBe("anthropic/claude-haiku-4-5");
    expect(view.reasoningEffort).toBe("low");
  });

  test("WorkersPanel renders switcher pills, metadata bar, and empty state", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      createElement(WorkersPanel, {
        catchUp: {
          status: "open",
          server: null,
          commands: [],
          agents: [],
          agentsLoaded: true,
          providers: null,
          loadProviders: () => Promise.resolve(),
          listModels: () => Promise.resolve([]),
          conversation: () => ({
            rows: [],
            status: "idle",
            error: null,
            older: null,
            loadFailed: null,
            pending: null,
            question: null,
            engine: null,
            mode: null,
            links: [],
            subagents: [],
            queued: [],
            cwd: null,
          }),
          subscribe: () => Promise.resolve(),
          loadThread: () => Promise.resolve(),
          watchThreads: () => () => {},
          threadRows: () => [],
          watchThread: () => () => {},
          send: () => {},
          answer: () => {},
          decide: () => {},
          execute: () => Promise.resolve({ success: true, output: "" }),
          cancelQueued: () => {},
          stop: () => Promise.resolve(null),
        } as unknown as Parameters<typeof WorkersPanel>[0]["catchUp"],
        agentId: "agent-a",
        agentName: "Ada",
        subagents: [kestrel, ember],
        selectedChat: ember.chat_id,
        onSelectChat: noop,
        desk: { modelOf: () => null, reasoningEffortOf: () => null },
        models: { entries: null },
      }),
    );
    expect(html).toContain("loki-workers-bar");
    expect(html).toContain("kestrel");
    expect(html).toContain("ember");
    expect(html).toContain("2 / 2");
    expect(html).toContain('aria-label="Previous Worker"');
    expect(html).toContain('aria-label="Next Worker"');
    expect(html).toContain("Fix migration ordering");
    expect(html).toContain("loki-subagent/ember");
    expect(html).toContain('aria-pressed="true"');

    const single = renderToStaticMarkup(
      createElement(WorkersPanel, {
        catchUp: {
          status: "open",
          server: null,
          commands: [],
          agents: [],
          agentsLoaded: true,
          providers: null,
          loadProviders: () => Promise.resolve(),
          listModels: () => Promise.resolve([]),
          conversation: () => ({
            rows: [],
            status: "idle",
            error: null,
            older: null,
            loadFailed: null,
            pending: null,
            question: null,
            engine: null,
            mode: null,
            links: [],
            subagents: [],
            queued: [],
            cwd: null,
          }),
          subscribe: () => Promise.resolve(),
          loadThread: () => Promise.resolve(),
          watchThreads: () => () => {},
          threadRows: () => [],
          watchThread: () => () => {},
          send: () => {},
          answer: () => {},
          decide: () => {},
          execute: () => Promise.resolve({ success: true, output: "" }),
          cancelQueued: () => {},
          stop: () => Promise.resolve(null),
        } as unknown as Parameters<typeof WorkersPanel>[0]["catchUp"],
        agentId: "agent-a",
        agentName: "Ada",
        subagents: [kestrel],
        selectedChat: kestrel.chat_id,
        onSelectChat: noop,
        desk: { modelOf: () => null, reasoningEffortOf: () => null },
        models: { entries: null },
      }),
    );
    expect(single).not.toContain('aria-label="Previous Worker"');
    expect(single).not.toContain('aria-label="Next Worker"');

    const empty = renderToStaticMarkup(
      createElement(WorkersPanel, {
        catchUp: {} as Parameters<typeof WorkersPanel>[0]["catchUp"],
        agentId: "agent-a",
        agentName: "Ada",
        subagents: [],
        selectedChat: null,
        onSelectChat: noop,
        desk: { modelOf: () => null, reasoningEffortOf: () => null },
        models: { entries: null },
      }),
    );
    expect(empty).toBe("");
  });

  test("WorkersHeader renders a sibling switcher strip when activeChat is set with multiple workers", () => {
    const html = renderToStaticMarkup(
      createElement(
        OpenWorker.Provider,
        { value: () => {} },
        createElement(WorkersHeader, { subagents: [kestrel, ember], activeChat: ember.chat_id, touch: true }),
      ),
    );
    expect(html).toContain("loki-workers-strip--switcher");
    expect(html).toContain("kestrel");
    expect(html).toContain("ember");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
  });

  test("SubagentEventRow renders a clickable button to open the worker when OpenWorker context exists", () => {
    const html = renderToStaticMarkup(
      createElement(
        OpenWorker.Provider,
        { value: () => {} },
        createElement(SubagentEventRow, {
          row: {
            role: "event",
            text: "subagent kestrel completed",
            summary: "Found 2 issues",
            subagent_chat: "c1~subagent~kestrel",
            event: "subagent",
          },
        }),
      ),
    );
    expect(html).toContain("subagent kestrel completed");
    expect(html).toContain("Found 2 issues");
    expect(html).toContain('title="Open in Workers"');
  });
});
