import { useEffect, useState } from "react";
import { inTauri, modBase } from "../desk/env";
import { KEYMAP, WHERE_ORDER, formatKeys } from "./keymap";
import { CHAT_PLACEMENTS, type ChatPlacement, type ChatWidth } from "../chat/ChatWindow";

const HOME = "~/.letta/loki";

/**
 * Settings: the facts that had no home — which harness the app is on, how it reaches
 * the mod, where the files are — a couple of preferences, and the keymap.
 */
export function Settings({
  appServerStatus,
  tunnelUrl,
  modConnection,
  deskCount,
  chatWidth,
  onChatWidth,
  chatPlacement,
  onChatPlacement,
}: {
  appServerStatus: "connecting" | "open" | "closed" | "unavailable";
  tunnelUrl: string | null;
  modConnection: "connecting" | "open" | "closed";
  deskCount: number;
  chatWidth: ChatWidth;
  onChatWidth: (w: ChatWidth) => void;
  chatPlacement: ChatPlacement;
  onChatPlacement: (p: ChatPlacement) => void;
}) {
  const [appServerUrl, setAppServerUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!inTauri) return setAppServerUrl(tunnelUrl);
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke<string>("appserver_url")).then(setAppServerUrl).catch(() => setAppServerUrl(null));
  }, [tunnelUrl]);
  // Never print the token: a browser tab's tunnel URL carries it as a query.
  const shownUrl = appServerUrl ? appServerUrl.replace(/\?.*$/, "") : null;
  const viaTunnel = !!appServerUrl && appServerUrl.includes("/appserver");
  const ownHarness = !!appServerUrl && /:41600\//.test(appServerUrl);
  const runner = !appServerUrl ? "not found" : viaTunnel ? "whichever harness the mod found — this tab reaches it through the mod's tunnel" : ownHarness ? "loki's own harness (letta server --listen), adopted or spawned at launch" : "Letta Desktop";

  return (
    <div style={{ position: "absolute", inset: 0, overflowY: "auto", padding: "28px 40px 60px", boxSizing: "border-box" }}>
      <div style={{ maxWidth: 720, margin: "0 auto", display: "grid", gap: 28 }}>
        <Section title="harness" hint="the Letta process loki talks to; the mod runs inside it">
          <Fact label="app-server" value={shownUrl ?? "—"} mono />
          <Fact label="who runs it" value={runner} />
          <Fact label="link" value={<Status s={appServerStatus} />} />
        </Section>
        <Section title="mod" hint="desk layout, widget files, transcripts">
          <Fact label="endpoint" value={modBase()} mono />
          <Fact label="link" value={<Status s={modConnection} />} />
          <Fact label="desks" value={String(deskCount)} mono />
        </Section>
        <Section title="files" hint="everything loki keeps, in one folder">
          <Fact label="widgets" value={`${HOME}/widgets/<desk>/`} mono />
          <Fact label="layout" value={`${HOME}/state/<desk>.json`} mono />
          <Fact label="inbox marks" value={`${HOME}/state/attention.json`} mono />
          <Fact label="board" value={`${HOME}/board  (beads · bd, embedded Dolt, prefix lk)`} mono />
          <Fact label="token" value={`${HOME}/token`} mono />
          <Fact label="logs" value={`${HOME}/mod.log · ${HOME}/logs/harness.log`} mono />
        </Section>
        <Section title="chat" hint="how the panel sits on the sheet">
          <Fact label="position" value={<Choice options={CHAT_PLACEMENTS} value={chatPlacement} onPick={onChatPlacement} labels={{ center: "centre" }} />} />
          <Fact label="side width" value={<Choice options={["narrow", "wide"] as ChatWidth[]} value={chatWidth} onPick={onChatWidth} />} />
          <Fact label="empty desk" value="opens the chat centred until the first widget lands" />
          <Fact label="later" value="5m · 15m · 45m · 2h · 6h · 1d, one step further each time a card is deferred" />
        </Section>
        <Section title="keys" hint="⌘ here is ctrl on other systems">
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
            <tbody>
              {WHERE_ORDER.flatMap((where) => KEYMAP.filter((b) => b.where === where)).map((b, i, rows) => (
                <tr key={b.id} style={{ borderTop: i > 0 && rows[i - 1].where !== b.where ? "1px solid var(--loki-border)" : undefined }}>
                  <td className="loki-label" style={{ padding: "6px 0", width: 90, fontSize: 9.5, verticalAlign: "top", paddingTop: 9 }}>{i === 0 || rows[i - 1].where !== b.where ? b.where : ""}</td>
                  <td style={{ padding: "6px 12px 6px 0", width: 170, fontFamily: "var(--loki-mono)", fontSize: 12, color: "var(--loki-fg)", whiteSpace: "nowrap" }}>{b.keys.map(formatKeys).join(" · ")}</td>
                  <td style={{ padding: "6px 0", color: "var(--loki-muted)" }}>
                    {b.label}
                    {b.typing ? "" : b.where === "inbox" || b.where === "desk" ? <span style={{ marginLeft: 8, fontSize: 10.5, opacity: 0.7 }}>not while typing</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
        <div className="loki-label" style={{ fontSize: 9, textAlign: "center" }}>
          loki {__LOKI_VERSION__} · {inTauri ? "tauri shell" : "browser tab"}
        </div>
      </div>
    </div>
  );
}

function Choice<T extends string>({ options, value, onPick, labels = {} }: { options: T[]; value: T; onPick: (v: T) => void; labels?: Partial<Record<T, string>> }) {
  return (
    <span style={{ display: "inline-flex", gap: 6 }}>
      {options.map((o) => (
        <button key={o} onClick={() => onPick(o)} aria-pressed={value === o} className="loki-label" style={{ padding: "4px 10px", border: `1px solid ${value === o ? "var(--loki-accent)" : "var(--loki-border)"}`, background: value === o ? "var(--loki-brass-soft)" : "transparent", color: value === o ? "var(--loki-accent)" : "var(--loki-muted)", cursor: "pointer", fontSize: 10 }}>
          {labels[o] ?? o}
        </button>
      ))}
    </span>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: "6px 24px", alignItems: "start" }}>
      <div style={{ paddingTop: 2 }}>
        <div style={{ fontFamily: "var(--loki-display)", fontSize: 17, color: "var(--loki-fg)" }}>{title}</div>
        {hint && <div style={{ fontSize: 11.5, color: "var(--loki-muted)", marginTop: 4, lineHeight: 1.45 }}>{hint}</div>}
      </div>
      <div style={{ display: "grid", gap: 6, borderLeft: "1px solid var(--loki-border)", paddingLeft: 20 }}>{children}</div>
    </section>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 12, alignItems: "baseline", fontSize: 13, lineHeight: 1.5 }}>
      <span className="loki-label" style={{ fontSize: 9.5 }}>{label}</span>
      <span style={{ color: "var(--loki-fg)", fontFamily: mono ? "var(--loki-mono)" : undefined, fontSize: mono ? 12 : 13, overflowWrap: "anywhere" }}>{value}</span>
    </div>
  );
}

function Status({ s }: { s: string }) {
  const color = s === "open" ? "var(--loki-positive)" : s === "connecting" ? "var(--loki-accent)" : "var(--loki-negative)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color, fontFamily: "var(--loki-label)", fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase" }}>
      <span style={{ width: 6, height: 6, borderRadius: 3, background: color }} />
      {s}
    </span>
  );
}
