import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { AgentStore } from "../daemon/kernel/index.ts";
import { StoreManager } from "../daemon/kernel/stores.ts";
import { ChatProjection } from "../daemon/chats.ts";
import { PassRunner, type PassSummary } from "../daemon/passes.ts";
import { PassState } from "../daemon/passes-state.ts";
import { createAgent } from "../daemon/store/agents.ts";
import { editMemoryFile, memoryExtension, memoryRoot } from "../daemon/memory.ts";
import { DOCTOR_INSTRUCTIONS } from "../daemon/doctor.ts";
import { PASS_RUN_TIMEOUT_MS } from "../core/frames.ts";

const ctx = BACKGROUND_CONTEXT;
const log = (root: string) => execFileSync("git", ["-C", root, "log", "--format=%an|%s"], { encoding: "utf8" }).trim().split("\n");

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "loki-doctor-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const agentId = await createAgent(dir, { name: "Ada", model: `${faux.provider.id}/${faux.getModel().id}` });
  const registry = createRegistry();
  registry.install(memoryExtension(dir));
  const open = () => AgentStore.open({ storage: new MemoryStorage() }, { models, registry }, ctx);
  const stores = new StoreManager(join(dir, "stores"), { models, registry }, ctx, () => {}, open);
  const chats = new ChatProjection(ctx, () => "Ada");
  chats.follow(stores, () => {});
  const store = await stores.get(agentId);
  await store.setAgent({ id: agentId, name: "Ada" }, ctx);
  const events: PassSummary[] = [];
  const runner = new PassRunner({
    stores,
    chats,
    registry,
    state: new PassState(join(dir, "state")),
    backendDir: dir,
    context: ctx,
    jobs: [],
    busy: () => Promise.resolve(false),
    onPass: (p) => events.push(p),
  });
  const asked: Array<{ systemPrompt?: string; messages: unknown[] }> = [];
  const reply = (m: ReturnType<typeof fauxAssistantMessage>) => (c: { systemPrompt?: string; messages: unknown[] }) => (asked.push(c), m);
  const cleanup = async () => {
    await stores.closeAll();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, faux, agentId, store, runner, events, asked, reply, root: memoryRoot(dir, agentId), cleanup };
}

describe("the memory review (/doctor)", () => {
  test("it reads all of memory, edits it as the Doctor, and reports each change", async () => {
    const s = await setup();
    try {
      await editMemoryFile(s.dir, s.agentId, "reference/deploys.md", "Deploys go out on Fridays.\n");
      await editMemoryFile(s.dir, s.agentId, "reference/deploy-day.md", "We deploy every Friday.\n");
      await editMemoryFile(s.dir, s.agentId, "reference/launch.md", "Launch on 30 Sept 2026.\n");
      s.faux.setResponses([
        s.reply(
          fauxAssistantMessage(fauxToolCall("memory_write", { path: "reference/deploy-day.md", content: null, message: "Merge the two deploy notes" }), {
            stopReason: "toolUse",
          }),
        ),
        s.reply(
          fauxAssistantMessage(
            fauxToolCall("memory_edit", {
              path: "reference/launch.md",
              old_text: "Launch on 30 Sept 2026.",
              new_text: "Launched on 30 Sept 2026.",
              message: "The launch date has passed",
            }),
            { stopReason: "toolUse" },
          ),
        ),
        s.reply(fauxAssistantMessage("- merged the two deploy notes\n- the launch has happened")),
      ]);
      const r = await s.runner.runDoctor(s.agentId);
      expect(r).toEqual({ outcome: "changed", changes: 2, report: "- merged the two deploy notes\n- the launch has happened" });
      const first = JSON.stringify(s.asked[0]);
      expect(first).toContain("reference/deploy-day.md");
      expect(first).toContain("We deploy every Friday.");
      expect(first).toContain(`Today is ${new Date().toISOString().slice(0, 10)}`);
      expect(first).toContain(DOCTOR_INSTRUCTIONS.slice(0, 60));
      expect(existsSync(join(s.root, "reference/deploy-day.md"))).toBe(false);
      expect(readFileSync(join(s.root, "reference/launch.md"), "utf8")).toBe("Launched on 30 Sept 2026.\n");
      expect(log(s.root).slice(0, 2)).toEqual(["Doctor|The launch date has passed", "Doctor|Merge the two deploy notes"]);
      expect(s.events.at(-1)).toMatchObject({ job: "doctor", agent: s.agentId, outcome: "changed", items: { memory_changes: 2 }, files: 4 });
      expect((await s.store.chats(ctx)).find((c) => c.id === `doctor-${s.agentId}`)?.hidden).toBe(true);
    } finally {
      await s.cleanup();
    }
  });

  test("a review that changes nothing says memory is healthy; a second one while the first runs is not started", async () => {
    const s = await setup();
    try {
      s.faux.setResponses([s.reply(fauxAssistantMessage("Memory looks healthy."))]);
      const [a, b] = await Promise.all([s.runner.runDoctor(s.agentId), s.runner.runDoctor(s.agentId)]);
      expect(a).toEqual({ outcome: "nothing", changes: 0, report: "Memory looks healthy." });
      expect(b).toEqual({ outcome: "skipped", changes: 0, report: "a memory review of this agent is already running" });
      expect(s.asked).toHaveLength(1);
    } finally {
      await s.cleanup();
    }
  });

  test("a review asked for while passes wait runs next, after only the pass already running and earlier reviews, and answers without waiting for the rest", async () => {
    const s = await setup();
    try {
      await editMemoryFile(s.dir, s.agentId, "reference/deploys.md", "Deploys go out on Fridays.\n");
      const order: string[] = [];
      s.faux.setResponses([() => (order.push("doctor"), fauxAssistantMessage("Memory looks healthy."))]);
      const gate: { started?: () => void; open?: () => void; openSecond?: () => void } = {};
      const started = new Promise<void>((r) => (gate.started = r));
      const first = s.runner["schedule"](["first"], () => {
        order.push("first");
        gate.started?.();
        return new Promise<void>((r) => (gate.open = r));
      });
      void s.runner["drain"]();
      await started;
      const secondHeld = new Promise<void>((r) => (gate.openSecond = r));
      const second = s.runner["schedule"](["second"], () => (order.push("second"), secondHeld));
      const review = s.runner.runDoctor(s.agentId);
      const later = s.runner["schedule"](["later"], () => (order.push("later"), Promise.resolve()), "next");
      gate.open?.();
      expect(await review).toEqual({ outcome: "nothing", changes: 0, report: "Memory looks healthy." });
      gate.openSecond?.();
      await Promise.all([first, second, later]);
      expect(order).toEqual(["first", "doctor", "later", "second"]);
    } finally {
      await s.cleanup();
    }
  });

  test("a review whose time ran out while it waited is not started, and says to run it again", async () => {
    const s = await setup();
    try {
      await editMemoryFile(s.dir, s.agentId, "reference/deploys.md", "Deploys go out on Fridays.\n");
      const t0 = Date.parse("2026-11-18T09:00:00Z");
      let reads = 0;
      s.runner["deps"].now = () => new Date(reads++ === 0 ? t0 : t0 + PASS_RUN_TIMEOUT_MS);
      expect(await s.runner.runDoctor(s.agentId)).toEqual({
        outcome: "skipped",
        changes: 0,
        report: "the other memory passes ran long, so the review did not start; run /doctor again",
      });
      expect(s.asked).toHaveLength(0);
    } finally {
      await s.cleanup();
    }
  });

  test("a review that fails says why, and asks nothing when there is no memory", async () => {
    const s = await setup();
    try {
      s.faux.setResponses([
        () => {
          throw new Error("model down");
        },
      ]);
      const failed = await s.runner.runDoctor(s.agentId);
      expect(failed.outcome).toBe("failed");
      expect(failed.report).toMatch(/did not finish/);
      rmSync(s.root, { recursive: true, force: true });
      expect(await s.runner.runDoctor(s.agentId)).toEqual({ outcome: "nothing", changes: 0, report: "this agent has no memory to review yet" });
    } finally {
      await s.cleanup();
    }
  });
});
