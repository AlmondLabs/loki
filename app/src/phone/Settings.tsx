import { useState, type ReactNode } from "react";
import { modBase } from "../desk/env";
import type { Me } from "./Pair";
import { routeOf } from "./model";
import { currentBuild } from "./UpdateBar";
import { Button, Dot, Title } from "../components";
import { GUTTER, Scroll, TopBar } from "./ui";

/**
 * Settings on the phone: three short sections in the desktop's Section / Fact voice, stacked. What
 * this phone is and how to unpair it; what the Mac is and whether the two links are up; and a line
 * about where everything else lives. No brass here — nothing on this page waits for you.
 */
export function Settings({
  me,
  version,
  modLink,
  appServerLink,
  sub,
  banner,
  onUnpaired,
}: {
  me: Me;
  /** Letta Code's version, from app_server_info; null until it answered. */
  version: string | null;
  modLink: "connecting" | "open" | "closed";
  appServerLink: "off" | "connecting" | "open" | "closed";
  sub?: ReactNode;
  banner?: ReactNode;
  onUnpaired: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unpair = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${modBase()}/unpair`, { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: "{}" });
      if (!r.ok) throw new Error(`the Mac answered ${r.status}`);
      onUnpaired();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <TopBar title="Settings" sub={sub} />
      {banner}
      <Scroll style={{ display: "grid", gap: 24, alignContent: "start", padding: `18px ${GUTTER.right} 32px ${GUTTER.left}` }}>
        <Section title="this phone" hint="paired to the Mac; nothing is installed">
          <Fact label="name" value={me.name} />
          <Fact label="paired" value="paired" />
          {confirm ? (
            <div role="alertdialog" aria-label="unpair this phone" style={{ display: "grid", gap: 10, padding: "10px 12px", border: "1px solid var(--loki-negative)", borderRadius: 8, fontSize: 13.5, lineHeight: 1.5, color: "var(--loki-fg)" }}>
              <span>This phone forgets the Mac and the Mac forgets it. Pairing again takes a fresh code from Settings › phone on the Mac.</span>
              <div style={{ display: "flex", gap: 8 }}>
                <Button size="touch" onClick={() => setConfirm(false)} disabled={busy} style={{ flex: 1 }}>
                  keep
                </Button>
                <Button size="touch" tone="negative" onClick={() => void unpair()} disabled={busy} style={{ flex: 1 }}>
                  {busy ? "unpairing…" : "unpair"}
                </Button>
              </div>
              {error && <div role="alert" style={{ fontSize: 12, color: "var(--loki-negative)", fontFamily: "var(--loki-mono)" }}>{error}</div>}
            </div>
          ) : (
            <div>
              <Button size="touch" tone="negative" onClick={() => setConfirm(true)} style={{ marginTop: 4 }}>
                unpair this phone
              </Button>
            </div>
          )}
        </Section>

        <Section title="the Mac" hint="loki's mod serves this page; Letta's app-server answers the chats">
          <Fact label="address" value={location.host} mono />
          <Fact label="route" value={routeOf(location.host, location.protocol)} />
          <Fact label="letta code" value={version ?? "—"} mono />
          <Fact label="mod" value={<Link state={modLink} />} />
          <Fact label="app-server" value={<Link state={appServerLink} />} />
          <Fact label="build" value={currentBuild() ?? "unstamped"} mono />
          <div>
            <Button size="touch" onClick={() => location.reload()} style={{ marginTop: 4 }} title="a home-screen app has no reload button; this is it">
              reload the app
            </Button>
          </div>
        </Section>

        <Section title="elsewhere" hint="what the phone does not carry">
          <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: "var(--loki-fg)" }}>Providers, agents, skills and the desk itself live in loki on the Mac. This phone reads the desks, answers the inbox and talks to the agents; the Mac does the rest.</p>
        </Section>
      </Scroll>
    </div>
  );
}

/** A link's state as a dot and a word: verdigris open, muted while connecting, oxblood closed, muted "off" when there is none to make. */
function Link({ state }: { state: "off" | "connecting" | "open" | "closed" }) {
  const color = state === "open" ? "var(--loki-positive)" : state === "closed" ? "var(--loki-negative)" : "var(--loki-muted)";
  const word = state === "open" ? "linked" : state === "closed" ? "reconnecting" : state === "connecting" ? "connecting" : "none found";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color }}>
      <Dot aria-hidden color={color} />
      {word}
    </span>
  );
}

/** The desktop Settings' Section, stacked for a narrow column: title and hint above, facts on a hairline. */
function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section style={{ display: "grid", gap: 10 }}>
      <div>
        <Title>{title}</Title>
        {hint && <div style={{ fontSize: 12, color: "var(--loki-muted)", marginTop: 3, lineHeight: 1.45 }}>{hint}</div>}
      </div>
      <div style={{ display: "grid", gap: 8, borderLeft: "1px solid var(--loki-border)", paddingLeft: 14 }}>{children}</div>
    </section>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "88px 1fr", gap: 12, alignItems: "baseline", fontSize: 13.5, lineHeight: 1.5 }}>
      <span className="loki-label" style={{ fontSize: 9.5 }}>{label}</span>
      <span style={{ color: "var(--loki-fg)", fontFamily: mono ? "var(--loki-mono)" : undefined, fontSize: mono ? 12 : 13.5, overflowWrap: "anywhere" }}>{value}</span>
    </div>
  );
}
