import { describe, expect, test } from "vitest";
import type { MouseEvent } from "react";
import type { Action, ExternalToast } from "sonner";
import type { AttentionItem } from "../core/attention/model.ts";
import { menuSpec } from "../app/src/shell/keymap.ts";
import { chatWorking, runUpdateItem, showReadyUpdate } from "../app/src/shell/update-notice.tsx";
import { readyVersion, updateItemLabel, type LokiUpdate, type UpdateState, type UpdateStatus } from "../app/src/shell/use-loki-update.ts";

// Plan 2026-11-15-2319, U5 (R10, R11, AE3): the loki menu's update item checks now, or restarts to a ready update; the
// Restart to Update notice shows once per ready update and says when a chat's turn would stop.

const status = (state: UpdateState): UpdateStatus => ({ channel: "stable", current: "2026.1116.0", state });
const ready = status({ kind: "ready", version: "2026.1117.0" });

/** A stand-in for the notices, keeping what each call showed so a test can press its buttons. */
function fakeNotices() {
  const shown: Array<{ title: string; data?: ExternalToast; loading: boolean }> = [];
  const dismissed: Array<string | number | undefined> = [];
  const toaster = Object.assign(
    (title: string, data?: ExternalToast) => {
      shown.push({ title, data, loading: false });
      return 1;
    },
    {
      loading: (title: string, data?: ExternalToast) => {
        shown.push({ title, data, loading: true });
        return 1;
      },
      dismiss: (id?: string | number) => {
        dismissed.push(id);
        return 1;
      },
    },
  );
  const last = () => shown.at(-1);
  const press = (which: "action" | "cancel") => {
    const button = last()?.data?.[which] as Action | undefined;
    if (!button) throw new Error(`the notice has no ${which}`);
    button.onClick({ preventDefault: () => {} } as MouseEvent<HTMLButtonElement>);
    return typeof button.label === "string" ? button.label : null;
  };
  const label = (which: "action" | "cancel") => {
    const button = last()?.data?.[which] as Action | undefined;
    return typeof button?.label === "string" ? button.label : null;
  };
  return { toaster, shown, dismissed, last, press, label };
}

/** An update model whose commands are counted. */
function fakeUpdate(s: UpdateStatus | null) {
  const calls = { check: 0, restart: 0 };
  const update: LokiUpdate = {
    status: s,
    releases: null,
    check: () => {
      calls.check++;
    },
    setChannel: () => {},
    restart: () => {
      calls.restart++;
      return Promise.resolve(null);
    },
  };
  return { update, calls };
}

describe("the update item", () => {
  test("it reads Check for Updates… until an update is ready, then Restart to Update…", () => {
    expect(updateItemLabel(null)).toBe("Check for Updates…");
    expect(updateItemLabel(status({ kind: "idle" }))).toBe("Check for Updates…");
    expect(updateItemLabel(status({ kind: "downloading", done: 1, total: 10 }))).toBe("Check for Updates…");
    expect(updateItemLabel(ready)).toBe("Restart to Update…");
  });

  test("Check for Updates… asks the shell to check now and shows About", () => {
    const fake = fakeUpdate(status({ kind: "idle" }));
    let about = 0;
    runUpdateItem(
      fake.update,
      false,
      () => {
        about++;
      },
      fakeNotices().toaster,
    );
    expect(fake.calls).toEqual({ check: 1, restart: 0 });
    expect(about).toBe(1);
  });

  test("with an update ready and no chat working, Restart to Update… restarts straight away", () => {
    const fake = fakeUpdate(ready);
    runUpdateItem(fake.update, false, () => {}, fakeNotices().toaster);
    expect(fake.calls).toEqual({ check: 0, restart: 1 });
  });

  test("with a chat working, Restart to Update… says its turn will stop and restarts only on Update Anyway", () => {
    const fake = fakeUpdate(ready);
    const notices = fakeNotices();
    runUpdateItem(fake.update, true, () => {}, notices.toaster);
    expect(fake.calls.restart).toBe(0);
    expect(notices.last()?.title).toContain("stops its turn");
    expect(notices.label("action")).toBe("Update Anyway");
    notices.press("action");
    expect(fake.calls.restart).toBe(1);
  });

  test("a development build never offers an update: no item, no notice", () => {
    const dev = status({ kind: "unsupported", reason: "development" });
    expect(updateItemLabel(dev)).toBe("Check for Updates…");
    expect(readyVersion(dev)).toBeNull();
    const notices = fakeNotices();
    showReadyUpdate(readyVersion(dev), new Set(), { working: () => false, restart: fakeUpdate(dev).update.restart }, notices.toaster);
    expect(notices.shown).toEqual([]);
  });

  test("the loki menu holds Settings… and the update item, first in the list the Mac and ☰ both build from", () => {
    const [first] = menuSpec(undefined, "macos", { "app.update": "Restart to Update…" });
    expect(first.title).toBe("loki");
    expect(first.items.filter((it) => "id" in it).map((it) => ("label" in it ? it.label : null))).toEqual(["Settings…", "Restart to Update…"]);
  });
});

describe("the Restart to Update notice", () => {
  test("with no chat working, Restart to Update calls the restart command straight away (AE3)", () => {
    const fake = fakeUpdate(ready);
    const notices = fakeNotices();
    showReadyUpdate("2026.1117.0", new Set(), { working: () => false, restart: fake.update.restart }, notices.toaster);
    expect(notices.last()?.title).toContain("2026.1117.0");
    expect(notices.last()?.data?.description).toBe("It installs when you quit loki");
    expect(notices.label("cancel")).toBe("Later");
    expect(notices.press("action")).toBe("Restart to Update");
    expect(fake.calls.restart).toBe(1);
    expect(notices.last()?.loading).toBe(true);
  });

  test("with a chat working, it offers Update Anyway and restarts only when that is chosen (AE3)", () => {
    const fake = fakeUpdate(ready);
    const notices = fakeNotices();
    showReadyUpdate("2026.1117.0", new Set(), { working: () => true, restart: fake.update.restart }, notices.toaster);
    notices.press("action");
    expect(fake.calls.restart).toBe(0);
    expect(notices.last()?.title).toContain("stops its turn");
    expect(notices.label("action")).toBe("Update Anyway");
    notices.press("cancel");
    expect(fake.calls.restart).toBe(0);
    showReadyUpdate("2026.1117.0", new Set(), { working: () => true, restart: fake.update.restart }, notices.toaster);
    notices.press("action");
    notices.press("action");
    expect(fake.calls.restart).toBe(1);
  });

  test("a failed install says so in the notice", async () => {
    const notices = fakeNotices();
    showReadyUpdate("2026.1117.0", new Set(), { working: () => false, restart: () => Promise.resolve("the disk is full") }, notices.toaster);
    notices.press("action");
    await Promise.resolve();
    await Promise.resolve();
    expect(notices.last()?.title).toContain("could not install");
    expect(notices.last()?.data?.description).toBe("The disk is full. This version is still running.");
  });

  test("it shows once per ready update: Later hides it for the launch, and a re-check of the same update brings nothing back", () => {
    const notices = fakeNotices();
    const offered = new Set<string>();
    const commands = { working: () => false, restart: fakeUpdate(ready).update.restart };
    const step = (s: UpdateStatus) => showReadyUpdate(readyVersion(s), offered, commands, notices.toaster);
    step(status({ kind: "downloading", done: 1, total: 10 }));
    expect(notices.shown).toEqual([]);
    step(ready);
    expect(notices.shown.map((n) => n.title)).toEqual(["loki 2026.1117.0 is ready"]);
    // Later, then the same update heard again (a re-check, a channel change).
    notices.press("cancel");
    step(ready);
    expect(notices.shown).toHaveLength(1);
    step(status({ kind: "ready", version: "2026.1118.0" }));
    expect(notices.shown.map((n) => n.title)).toEqual(["loki 2026.1117.0 is ready", "loki 2026.1118.0 is ready"]);
  });

  test("a chat that starts working after the notice showed still gets Update Anyway: working is asked at the press (AE3)", () => {
    const fake = fakeUpdate(ready);
    const notices = fakeNotices();
    let working = false;
    showReadyUpdate("2026.1117.0", new Set(), { working: () => working, restart: fake.update.restart }, notices.toaster);
    working = true;
    notices.press("action");
    expect(fake.calls.restart).toBe(0);
    expect(notices.last()?.title).toBe("A chat is working, and restarting now stops its turn");
  });

  test("the notice goes once no update is ready any more, leaving a failed install's notice up", () => {
    const notices = fakeNotices();
    const offered = new Set<string>();
    const commands = { working: () => false, restart: fakeUpdate(ready).update.restart };
    showReadyUpdate("2026.1117.0", offered, commands, notices.toaster);
    expect(notices.dismissed).toEqual([]);
    showReadyUpdate(readyVersion(status({ kind: "failed", stage: "install", message: "boom" })), offered, commands, notices.toaster);
    expect(notices.dismissed).toEqual(["loki-update-ready"]);
  });

  test("a chat is working while a turn runs or waits on an approval or a question, not while a proposed reply waits", () => {
    type Item = Pick<AttentionItem, "status" | "pendingApproval" | "pendingQuestion">;
    const item = (s: Partial<Item>): Item => ({ status: "idle", pendingApproval: null, pendingQuestion: null, ...s });
    const approval = { requestId: "r1", toolName: "bash", input: {}, at: "2026-11-16T10:00:00Z" };
    expect(chatWorking([])).toBe(false);
    expect(chatWorking([item({}), item({ status: "done" })])).toBe(false);
    expect(chatWorking([item({}), item({ status: "running" })])).toBe(true);
    expect(chatWorking([item({ status: "approval", pendingApproval: approval })])).toBe(true);
    expect(chatWorking([item({ status: "approval" })])).toBe(false);
    // An agent's question holds its turn open as an approval does: restarting would stop it unasked.
    const question = { requestId: "r2", input: {}, questions: [], at: "2026-11-16T10:00:00Z" };
    expect(chatWorking([item({ status: "question", pendingQuestion: question })])).toBe(true);
  });
});
