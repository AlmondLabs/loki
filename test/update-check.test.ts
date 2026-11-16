import { describe, expect, test } from "vitest";
import { createElement, isValidElement, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Action } from "sonner";
import { notify } from "../app/src/components/index.tsx";
import { LokiVersionFact } from "../app/src/settings/settings.tsx";
import type { LokiUpdate, UpdateState, UpdateStatus } from "../app/src/shell/use-loki-update.ts";

const RELEASES = "https://github.com/owner/loki/releases";
const status = (state: UpdateState, s: Partial<UpdateStatus> = {}): UpdateStatus => ({ channel: "stable", current: "2026.1116.0", state, ...s });

function fakeUpdate(s: UpdateStatus | null) {
  const calls = { check: 0, channels: [] as string[], restart: 0 };
  const update: LokiUpdate = {
    status: s,
    releases: RELEASES,
    check: () => {
      calls.check++;
    },
    setChannel: (c) => {
      calls.channels.push(c);
    },
    restart: () => {
      calls.restart++;
      return Promise.resolve(null);
    },
  };
  return { update, calls };
}

const html = (s: UpdateStatus | null) => renderToStaticMarkup(createElement(LokiVersionFact, { update: fakeUpdate(s).update, working: false }));

function elements(node: ReactNode): Array<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  const inner = Object.values(el.props).flatMap((v) => (isValidElement(v) || Array.isArray(v) ? elements(v as ReactNode) : []));
  return [el, ...inner];
}

const buttons = (node: ReactNode) =>
  elements(node)
    .filter((e) => typeof e.props.onClick === "function" && typeof e.props.children === "string")
    .map((e) => ({ label: String(e.props.children), click: e.props.onClick as () => void }));

describe("About's update state", () => {
  test("idle is up to date, beside the version", () => {
    const out = html(status({ kind: "idle" }));
    expect(out).toContain("2026.1116.0");
    expect(out).toContain("Up to date");
    expect(out).not.toContain("brew");
  });

  test("checking, then downloading, with how far along once the size is known", () => {
    expect(html(status({ kind: "checking" }))).toContain("Checking…");
    const unknown = html(status({ kind: "downloading", done: 1_000_000, total: null }));
    expect(unknown).toContain("Downloading…");
    expect(unknown).not.toContain(" of ");
    expect(html(status({ kind: "downloading", done: 12_000_000, total: 31_000_000 }))).toContain("Downloading… 12 of 31 MB");
  });

  test("ready says it installs when you quit, with Restart to Update", () => {
    const fake = fakeUpdate(status({ kind: "ready", version: "2026.1117.0" }));
    const out = renderToStaticMarkup(createElement(LokiVersionFact, { update: fake.update, working: false }));
    expect(out).toContain("Ready — installs when you quit loki");
    const restart = buttons(LokiVersionFact({ update: fake.update, working: false })).find((b) => b.label === "Restart to Update");
    expect(restart).toBeDefined();
  });

  test("with a chat working, Restart to Update says its turn will stop and restarts only on Update Anyway (AE3)", () => {
    const fake = fakeUpdate(status({ kind: "ready", version: "2026.1117.0" }));
    const restart = buttons(LokiVersionFact({ update: fake.update, working: true })).find((b) => b.label === "Restart to Update");
    restart?.click();
    expect(fake.calls.restart).toBe(0);
    const notice = notify.getToasts().find((t) => t.id === "loki-update-ready");
    expect(notice && "title" in notice ? notice.title : null).toBe("A chat is working, and restarting now stops its turn");
    const anyway = notice && "action" in notice ? (notice.action as Action | undefined) : undefined;
    expect(anyway?.label).toBe("Update Anyway");
    anyway?.onClick({ preventDefault: () => {} } as MouseEvent<HTMLButtonElement>);
    expect(fake.calls.restart).toBe(1);
  });

  test("a failed download or signature check says this version is still running, with Check Again", () => {
    for (const [stage, words] of [
      ["download", "The update did not download"],
      ["signature", "The update failed its signature check"],
      ["check", "Could not check for updates"],
      ["install", "The update did not install"],
    ] as const) {
      const fake = fakeUpdate(status({ kind: "failed", stage, message: "boom" }));
      const out = renderToStaticMarkup(createElement(LokiVersionFact, { update: fake.update, working: false }));
      expect(out).toContain(words);
      expect(out).toContain("this version is still running");
      const again = buttons(LokiVersionFact({ update: fake.update, working: false })).find((b) => b.label === "Check Again");
      again?.click();
      expect(fake.calls.check).toBe(1);
    }
  });

  test("a development build says updates are off, and a .deb links the releases page; neither offers a channel", () => {
    const dev = html(status({ kind: "unsupported", reason: "development" }));
    expect(dev).toContain("Updates are off in development builds");
    expect(dev).not.toContain("Nightly");
    const deb = html(status({ kind: "unsupported", reason: "package" }));
    expect(deb).toContain("This install updates from the");
    expect(deb).toContain(`href="${RELEASES}"`);
    expect(deb).not.toContain("Nightly");
  });
});

describe("About's channel", () => {
  test("the picker shows the saved channel, and choosing Nightly asks the shell to switch", () => {
    expect(html(status({ kind: "idle" }, { channel: "nightly" }))).toMatch(/aria-pressed="true"[^>]*>Nightly</);
    expect(html(status({ kind: "idle" }))).toMatch(/aria-pressed="true"[^>]*>Stable</);
    const fake = fakeUpdate(status({ kind: "idle" }));
    const picker = elements(LokiVersionFact({ update: fake.update, working: false })).find((e) => typeof e.props.onPick === "function");
    (picker?.props.onPick as (c: string) => void)("nightly");
    expect(fake.calls.channels).toEqual(["nightly"]);
  });

  test("on a nightly, the words say Stable waits for the next stable release", () => {
    const nightly = html(status({ kind: "idle" }, { current: "2026.1120.0-nightly.4821", channel: "stable" }));
    expect(nightly).toContain("Stable stays on it until the next stable release");
    expect(html(status({ kind: "idle" }))).not.toContain("until the next stable release");
  });

  test("outside the shell there is no status: the version alone, no channel and no state", () => {
    const g = globalThis as { __LOKI_VERSION__?: string };
    g.__LOKI_VERSION__ = "2026.1116.0";
    const out = html(null);
    expect(out).toContain("2026.1116.0");
    expect(out).not.toContain("Nightly");
    expect(out).not.toContain("Up to date");
  });
});
