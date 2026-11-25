import { describe, expect, test } from "vitest";
import type { ExternalToast } from "sonner";
import { installCommand, moveNoticeWords, showMoveNotice } from "../app/src/shell/move-notice.tsx";
import type { Notifier } from "../app/src/shell/update-notice.tsx";
import type { UpdateStatus } from "../app/src/shell/use-loki-update.ts";

const status = (moved: boolean, channel: UpdateStatus["channel"] = "stable"): UpdateStatus => ({
  channel,
  current: "2026.1125.0",
  state: { kind: "idle" },
  moved,
});

function fakeToast() {
  const shown: Array<{ title: string; data?: ExternalToast }> = [];
  const toast = Object.assign(
    (title: string, data?: ExternalToast) => {
      shown.push({ title, data });
      return title;
    },
    { loading: (title: string) => title, dismiss: (id?: string | number) => id ?? "" },
  ) as Notifier;
  return { toast, shown };
}

describe("the install line the reinstall notice offers", () => {
  test("the Mac and Linux run the install script, Nightly with its flag", () => {
    expect(installCommand("macos", "stable")).toBe("curl -fsSL https://almondlabs.github.io/loki/install.sh | sh");
    expect(installCommand("linux", "nightly")).toBe("curl -fsSL https://almondlabs.github.io/loki/install.sh | sh -s -- --nightly");
  });

  test("Windows runs the PowerShell script, Nightly through LOKI_CHANNEL", () => {
    expect(installCommand("windows", "stable")).toBe("irm https://almondlabs.github.io/loki/install.ps1 | iex");
    expect(installCommand("windows", "nightly")).toBe('$env:LOKI_CHANNEL = "nightly"; irm https://almondlabs.github.io/loki/install.ps1 | iex');
  });
});

describe("the notice that loki has moved", () => {
  test("covers AE7: a status saying loki moved shows the notice once, with the install line to copy", () => {
    const { toast, shown } = fakeToast();
    const seen = new Set<string>();
    showMoveNotice(status(true), "macos", seen, toast);
    showMoveNotice(status(true), "macos", seen, toast);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.title).toBe(moveNoticeWords("macos").title);
    expect(shown[0]?.data?.description).toContain("agents and chats stay");
    expect(shown[0]?.data?.action).toMatchObject({ label: "Copy Install Command" });
  });

  test("a status without the move shows nothing", () => {
    const { toast, shown } = fakeToast();
    showMoveNotice(status(false), "macos", new Set(), toast);
    showMoveNotice(null, "macos", new Set(), toast);
    expect(shown).toEqual([]);
  });

  test("the Mac's words name Homebrew and the keychain; the others do not", () => {
    expect(moveNoticeWords("macos").description).toContain("brew reinstall --cask loki");
    expect(moveNoticeWords("macos").description).toContain("keychain");
    expect(moveNoticeWords("windows").description).not.toContain("brew");
    expect(moveNoticeWords("linux").description).not.toContain("keychain");
  });
});
