import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { messageSteps, type PiMessage } from "../core/attention/pi-steps.ts";
import { foldSteps, MODEL_ERROR_TEXT, type Step } from "../core/attention/thread.ts";
import { ChatEventConverter } from "../daemon/chat-events.ts";
import type { Delivery } from "../daemon/engine.ts";
import { RETRY_AFTER_MINUTES, Schedules } from "../daemon/schedule.ts";

const AT = "2026-10-26T04:30:08.000Z";
const failed = (errorMessage = "OAuth refresh failed for openai: fetch failed"): PiMessage => ({
  role: "assistant",
  content: [],
  stopReason: "error",
  errorMessage,
});
const answer: PiMessage = { role: "assistant", content: [{ type: "text", text: "No reply from them yet." }], stopReason: "stop" };
const steps = (...messages: PiMessage[]): Step[] => [{ kind: "user", raw: "check the mail", at: AT }, ...messages.flatMap((m) => messageSteps(m, AT))];

describe("a model error stays in the chat (plan 037)", () => {
  test("a failed call is one quiet row with the provider's message, and the retries count on it", () => {
    const rows = foldSteps(steps(failed(), failed(), failed(), failed()));
    expect(rows.map((r) => [r.role, r.text, r.summary ?? null, r.detail ?? null])).toEqual([
      ["user", "check the mail", null, null],
      ["event", MODEL_ERROR_TEXT, "4 tries", "OAuth refresh failed for openai: fetch failed"],
    ]);
  });

  test("an error and then an answer shows only the answer: the turn got through", () => {
    expect(foldSteps(steps(failed(), answer)).map((r) => r.role)).toEqual(["user", "assistant"]);
  });

  test("different errors are rows of their own, and a long message is cut", () => {
    const rows = foldSteps(steps(failed("fetch failed"), failed(`429 ${"x".repeat(400)}`)));
    expect(rows.filter((r) => r.role === "event")).toHaveLength(2);
    expect(rows.at(-1)?.detail?.length).toBe(300);
  });

  test("an error with no message, or with words said, stays as it was", () => {
    expect(messageSteps({ role: "assistant", content: [], stopReason: "error" }, AT)).toEqual([{ kind: "assistant", text: "", at: AT }]);
    expect(messageSteps({ ...failed(), content: [{ type: "text", text: "Half" }] }, AT)[0]).toMatchObject({ kind: "assistant", text: "Half" });
  });

  test("a live chat gets the same step from the written message as history does", () => {
    const end = { type: "message_end", entry: { id: 1, conversationId: 1, kind: "pi.assistant", model: [failed()] } } as unknown as AgentEvent;
    expect(new ChatEventConverter().convert(end, AT)).toEqual(messageSteps(failed(), AT).map((step) => ({ kind: "step", step })));
  });
});

describe("a scheduled run that could not reach the model tries again (plan 037)", () => {
  /** A schedule whose fire hands back an outcome the test settles, on a clock the test moves. */
  function harness(dir: string, file = "crons.json") {
    const clock = { now: new Date("2026-10-26T04:30:00Z") };
    const fired: string[] = [];
    const ends: Array<(o: Awaited<Delivery["outcome"]>) => void> = [];
    const schedules = new Schedules(
      join(dir, file),
      (_a, _c, text) => {
        fired.push(text);
        return Promise.resolve({ outcome: new Promise((resolve) => ends.push(resolve)) });
      },
      () => {},
      () => clock.now,
    );
    const at = async (iso: string) => {
      clock.now = new Date(iso);
      return schedules.tick(clock.now);
    };
    /** End a firing's turn (the newest unless `which` says), and let the schedule hear of it. */
    const end = async (o: Awaited<Delivery["outcome"]>, which = ends.length - 1) => {
      ends[which]?.(o);
      await new Promise((r) => setImmediate(r));
    };
    return { schedules, fired, at, end };
  }
  const daily = {
    agent_id: "a",
    conversation_id: "c",
    name: "mail",
    description: null,
    cron: "0 10 * * *",
    timezone: "Asia/Kolkata",
    recurring: true,
    prompt: "check the mail",
  };
  const modelError = { status: "unanswered" as const, reason: "model_error" };

  test("after a model error it fires again at 5, 15 and 60 minutes, saying so, then stops", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-retry-"));
    try {
      const h = harness(dir);
      h.schedules.create(daily, new Date("2026-10-25T00:00:00Z"));
      expect(await h.at("2026-10-26T04:30:00Z")).toBe(1);
      await h.end(modelError);
      expect(RETRY_AFTER_MINUTES).toEqual([5, 15, 60]);
      expect(await h.at("2026-10-26T04:34:00Z")).toBe(0);
      expect(await h.at("2026-10-26T04:35:00Z")).toBe(1);
      expect(h.fired[1]).toBe('Scheduled task "mail": check the mail\n\n(another try: at 10:00 the model could not be reached)');
      await h.end(modelError);
      expect(await h.at("2026-10-26T04:50:00Z")).toBe(1);
      await h.end(modelError);
      expect(await h.at("2026-10-26T05:50:00Z")).toBe(1);
      await h.end(modelError);
      expect(await h.at("2026-10-26T07:00:00Z")).toBe(0);
      expect(h.schedules.list()[0]).toMatchObject({ retry_at: null, retries: 0, fire_count: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a turn that got through, or ended some other way, is not tried again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-retry-"));
    try {
      const h = harness(dir);
      h.schedules.create(daily, new Date("2026-10-25T00:00:00Z"));
      await h.at("2026-10-26T04:30:00Z");
      await h.end({ status: "done" });
      expect(h.schedules.list()[0].retry_at).toBeNull();
      await h.at("2026-10-27T04:30:00Z");
      await h.end({ status: "unanswered", reason: "no_model" });
      expect(h.schedules.list()[0].retry_at).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a waiting retry survives a restart, and a one-time task is still retried after it is done", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-retry-"));
    try {
      const h = harness(dir);
      h.schedules.create({ ...daily, recurring: false }, new Date("2026-10-25T00:00:00Z"));
      await h.at("2026-10-26T04:30:00Z");
      await h.end(modelError);
      expect(h.schedules.list()[0].status).toBe("done");
      const again = harness(dir);
      expect(await again.at("2026-10-26T04:35:00Z")).toBe(1);
      expect(again.fired[0]).toContain("(another try: at 10:00");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a turn that ends after its task fired again changes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-retry-"));
    try {
      const h = harness(dir);
      h.schedules.create({ ...daily, cron: "*/30 * * * *" }, new Date("2026-10-26T04:00:00Z"));
      await h.at("2026-10-26T04:30:00Z");
      await h.at("2026-10-26T05:00:00Z"); // the next slot fires while the first turn still runs
      await h.end({ status: "done" }, 1);
      // Now the first turn ends, late, with a model error: the newer firing got through, so no retry.
      await h.end(modelError, 0);
      expect(h.schedules.list()[0].retry_at).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a slot that comes due replaces a retry still waiting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-retry-"));
    try {
      const h = harness(dir);
      h.schedules.create({ ...daily, cron: "*/30 * * * *" }, new Date("2026-10-26T04:00:00Z"));
      await h.at("2026-10-26T04:30:00Z");
      await h.end(modelError);
      await h.at("2026-10-26T04:35:00Z");
      await h.end(modelError);
      // The retry would be at 04:50; the 05:00 slot comes first after a quiet spell, and fires as itself.
      expect(await h.at("2026-10-26T05:00:00Z")).toBe(1);
      expect(h.fired.at(-1)).toBe('Scheduled task "mail": check the mail');
      expect(h.schedules.list()[0]).toMatchObject({ retry_at: null, retries: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
