import { useEffect, useState, type ReactNode } from "react";
import { modBase } from "../desk/env";
import type { Me } from "./Pair";
import { PHONE_APPEARANCE, linkWord, routeOf, updateState, type LinkState, type UpdateState } from "./model";
import { currentBuild } from "./UpdateBar";
import { useTheme } from "../theme";
import { FactRow, MenuRow, RowGroup, StateWord } from "./rows";
import { BackButton, ConfirmSheet, Scroll, TopBar } from "./ui";

/**
 * The pages behind More's utility rows, in Slack's Preferences grammar — groups of rows on hairlines:
 *   Preferences         appearance: System, Light or Dark (the desktop's palettes never reach the phone)
 *   Connection details  the paired Mac, its two links and route, this phone, and unpairing
 *   About loki          the builds and versions, this screen, and what stays on the Mac
 * and the reload sheet More's Updates row opens. What used to be one Settings page, sorted by what it is for.
 */

type ModLink = "connecting" | "open" | "closed";
type AppServerLink = "off" | "connecting" | "open" | "closed";

/** A page under More: the back control, the title, the banner, then its groups. */
function Page({ title, backLabel, onBack, banner, children }: { title: string; backLabel: string; onBack: () => void; banner?: ReactNode; children: ReactNode }) {
  return (
    <div className="loki-phone-page">
      <TopBar left={<BackButton onClick={onBack} label={backLabel} />} title={title} />
      {banner}
      <Scroll flush>
        <div className="loki-phone-groups">{children}</div>
      </Scroll>
    </div>
  );
}

/** Appearance, kept on this phone: the choice applies at once, and the line under it says what it resolved to. */
export function Preferences({ banner, backLabel = "more", onBack }: { banner?: ReactNode; backLabel?: string; onBack: () => void }) {
  const theme = useTheme();
  return (
    <Page title="Preferences" backLabel={backLabel} onBack={onBack} banner={banner}>
      <RowGroup title="Appearance" radio>
        {PHONE_APPEARANCE.map((a) => (
          <MenuRow key={a.value} icon={a.value === "system" ? "laptop" : a.value === "light" ? "sun" : "moon"} label={a.label} checked={theme.preference === a.value} onClick={() => theme.setPreference(a.value)} />
        ))}
      </RowGroup>
      <p className="loki-phone-group-note">{theme.preference === "system" ? `Following this phone's setting: ${theme.resolved} now.` : `Always ${theme.resolved}.`} Kept on this phone only.</p>
    </Page>
  );
}

/** A socket's state in words: linked, connecting, reconnecting, or none to make. */
function LinkFact({ state }: { state: AppServerLink }) {
  const word = state === "open" ? "Linked" : state === "closed" ? "Reconnecting" : state === "connecting" ? "Connecting" : "None found";
  return <StateWord state={state === "open" ? "on" : state === "closed" ? "off" : "wait"}>{word}</StateWord>;
}

/**
 * The paired Mac and this phone. Unpairing is the one destructive action on the phone: a named row, then
 * a sheet that says what follows and how to pair again; a failure keeps the sheet open with the error.
 */
export function ConnectionPage({ me, link, modLink, appServerLink, banner, onUnpaired, backLabel = "more", onBack }: { me: Me; link: LinkState; modLink: ModLink; appServerLink: AppServerLink; banner?: ReactNode; onUnpaired: () => void; backLabel?: string; onBack: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unpair = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${modBase()}/unpair`, { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: "{}" });
      if (!r.ok) throw new Error(`The Mac answered ${r.status}.`);
      onUnpaired();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <Page title="Connection details" backLabel={backLabel} onBack={onBack} banner={banner}>
      <RowGroup title="Paired Mac">
        <FactRow label="Status" value={<StateWord state={link === "online" ? "on" : link === "offline" ? "off" : "wait"}>{linkWord(link)}</StateWord>} />
        <FactRow label="Desks (mod)" value={<LinkFact state={modLink} />} />
        <FactRow label="Chats (app-server)" value={<LinkFact state={appServerLink} />} />
        <FactRow label="Address" value={location.host} />
        <FactRow label="Route" value={routeOf(location.host, location.protocol)} />
      </RowGroup>
      <p className="loki-phone-group-note">Both links reconnect by themselves. The route is the address this page was opened on; the other route (Wi‑Fi or Tailscale) is another address, paired on its own from Settings › phone on the Mac.</p>
      <RowGroup title="This phone">
        <FactRow label="Name" value={me.name} />
        <FactRow label="Pairing" value="Paired" />
        <MenuRow icon="unlink" label="Unpair this phone" danger sheet launch="connection:unpair" onClick={() => (setError(null), setConfirm(true))} />
      </RowGroup>
      {confirm && (
        <ConfirmSheet title="Unpair this phone?" action="Unpair" busyAction="Unpairing…" busy={busy} error={error} onConfirm={() => void unpair()} onClose={() => setConfirm(false)}>
          This phone forgets the Mac and the Mac forgets it. To pair again, type a fresh code from Settings › phone on the Mac.
        </ConfirmSheet>
      )}
    </Page>
  );
}

/** What loki is on this phone: the build it runs against the one the Mac serves, Letta Code's version, the screen. */
export function AboutPage({ version, servedBuild, banner, backLabel = "more", onBack }: { version: string | null; servedBuild: string | null; banner?: ReactNode; backLabel?: string; onBack: () => void }) {
  const current = currentBuild();
  const update = updateState(servedBuild, current);
  const [reload, setReload] = useState(false);
  return (
    <Page title="About loki" backLabel={backLabel} onBack={onBack} banner={banner}>
      <RowGroup title="Versions">
        <FactRow label="This page" value={current ?? "Unstamped"} />
        <FactRow label="The Mac serves" value={servedBuild ?? current ?? "—"} />
        <FactRow label="Letta Code" value={version ?? "—"} />
        <MenuRow icon="refresh" label="Reload loki" aside={UPDATE_WORD[update]} sheet launch="about:reload" onClick={() => setReload(true)} />
      </RowGroup>
      <RowGroup title="This screen">
        <FactRow label="Viewport" value={<ViewportFact />} />
      </RowGroup>
      <RowGroup title="On the Mac">
        <li className="loki-phone-fact loki-phone-fact--prose">Providers, agents, skills and the desk itself live in loki on the Mac. This phone reads the desks, answers the Inbox and talks to the agents; the Mac does the rest.</li>
      </RowGroup>
      {reload && <ReloadSheet state={update} onClose={() => setReload(false)} />}
    </Page>
  );
}

const UPDATE_WORD: Record<UpdateState, string | null> = { ready: "Update ready", current: "Up to date", unknown: null };

/**
 * Reload, from More's Updates row or About: a home-screen app has no reload button, so this is it. It is
 * confirmed because it drops what only lives in this page — a reply not yet sent.
 */
export function ReloadSheet({ state, onClose }: { state: UpdateState; onClose: () => void }) {
  return (
    <ConfirmSheet title={state === "ready" ? "Update loki?" : "Reload loki?"} action={state === "ready" ? "Update now" : "Reload"} tone="brass" onConfirm={() => location.reload()} onClose={onClose}>
      {state === "ready" ? "The Mac has a newer loki than this page. " : state === "current" ? "This phone already runs the Mac's current loki. " : ""}
      Reloading opens it afresh; a reply you have not sent is lost. You stay paired.
    </ConfirmSheet>
  );
}

/** The safe-area insets as the page receives them, read off a probe element padded with env(). */
function safeInsets(): { top: number; bottom: number } {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)";
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const out = { top: Math.round(parseFloat(cs.paddingTop) || 0), bottom: Math.round(parseFloat(cs.paddingBottom) || 0) };
  probe.remove();
  return out;
}

/**
 * How the page is running, for telling a Safari home-screen app from a Chrome one or a browser tab:
 * the viewport the web view got against the screen (a shorter viewport is a host keeping a strip for
 * its own toolbar — nothing the page can paint), the insets, the visual viewport, the document height
 * and the display mode. Read at mount; a rotation re-reads it.
 */
function readViewport(): string {
  const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const insets = safeInsets();
  const visual = window.visualViewport ? Math.round(window.visualViewport.height) : null;
  return [
    `view ${window.innerWidth}×${window.innerHeight}`,
    `screen ${screen.width}×${screen.height}`,
    `insets ${insets.top}/${insets.bottom}`,
    `visual ${visual ?? "–"}`,
    `doc ${document.documentElement.clientHeight}`,
    standalone ? "web app" : "browser",
    navigator.userAgent.includes("CriOS") ? "chrome" : "safari",
  ].join(" · ");
}

function ViewportFact() {
  const [text, setText] = useState(readViewport);
  useEffect(() => {
    const onResize = () => setText(readViewport());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return <>{text}</>;
}
