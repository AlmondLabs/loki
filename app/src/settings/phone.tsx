import { useEffect, useEffectEvent, useState } from "react";
import QRCode from "qrcode";
import { Button, Dot, Row as PickRow, Switch } from "../components";
import { Block, Setting } from "./layout";
import { notYetOn, platform, type Platform } from "../desk/env";
import { countdown, lastSeen, pairUrlFor, tailnetAddress, viaLabel, wifiAddress, type PairCode, type PairedDevice, type PhoneLanStatus } from "../phone/model";
import type { LanVia, TailscaleStatus } from "../../../core/frame-types.ts";

/** What useDesk exposes as `phone`: the LAN listener's status, the paired phones, the last code, and the actions. */
export interface PhoneApi {
  status: PhoneLanStatus | null;
  devices: PairedDevice[] | null;
  lastCode: PairCode | null;
  refresh: () => void;
  setEnabled: (enabled: boolean) => void;
  /** Which way the QR sends the phone: the tailnet or this Wi‑Fi (`lan_via_set`). */
  setVia: (via: LanVia) => void;
  /** `tailscale serve` in front of the listener, for an https origin on the tailnet (`lan_serve_set`). */
  setServe: (enabled: boolean) => void;
  beginPair: () => void;
  forget: (id: string) => void;
}

const ROUTE_NAME: Record<LanVia, string> = { tailscale: "Tailscale", lan: "this Wi‑Fi" };

/**
 * Preferences › Phone, in blocks that answer four questions (plan 031). Can phones reach this Mac (a switch). Which way do
 * they come in (the route: one lit row, Tailscale or this Wi‑Fi; the lit one is what the QR carries and what a new
 * phone bookmarks). How does a new phone join (the QR, whose URL follows the lit route). Which phones are in, and
 * which way did each one last arrive.
 */
export function Phone({ phone, connected, os = platform }: { phone: PhoneApi; connected: boolean; os?: Platform }) {
  const { status, devices, lastCode } = phone;
  const here = os === "macos";
  const refresh = useEffectEvent(() => phone.refresh());
  useEffect(() => {
    if (connected && here) refresh();
  }, [connected, here]);

  // Pairing, the LAN listener and Tailscale are the Mac's for now (R3, AE4): a line in their place, no controls.
  if (!here) return <Setting label="Phone" help={notYetOn("Phone pairing", os)} />;
  if (!connected || !status) return <Setting label="Phone" help="asking the mod…" />;
  const on = status.enabled;

  return (
    <>
      <ReachBlock phone={phone} status={status} />
      {on && <RouteBlock phone={phone} status={status} />}
      {on && <PairBlock phone={phone} status={status} lastCode={lastCode} />}
      <PairedPhones devices={devices} on={on} onForget={phone.forget} />
    </>
  );
}

/** Whether phones can reach this Mac: the switch, and what stops the listener when something does. */
function ReachBlock({ phone, status }: { phone: PhoneApi; status: PhoneLanStatus }) {
  const on = status.enabled;
  return (
    <Block>
      <Setting
        label="Phones can reach this Mac"
        help={
          <>
            The inbox and your chats on a phone, over Tailscale or this Wi‑Fi; nothing to install.
            {status.error && (
              <span className="loki-meta--negative" style={{ display: "block" }}>
                {status.error}
              </span>
            )}
            {on && !status.app_served && (
              <span className="loki-meta--negative" style={{ display: "block" }}>
                The canvas build is missing; run npm run build:app.
              </span>
            )}
          </>
        }
      >
        <Switch on={on} onToggle={() => phone.setEnabled(!on)} label="phones can reach this Mac" hideLabel />
      </Setting>
    </Block>
  );
}

/** The way phones come in, and what anyone on it can do. */
function RouteBlock({ phone, status }: { phone: PhoneApi; status: PhoneLanStatus }) {
  const safety =
    status.via === "lan" ? "Plain http on this Wi‑Fi: on a network you do not trust, use Tailscale." : "The tailnet is yours alone; Funnel is never used.";
  return (
    <Block title="Route" help={`anyone on the lit route can open the page; only a paired phone can act. ${safety}`}>
      <div style={{ padding: "12px 0" }}>
        <Route status={status} onVia={phone.setVia} onServe={phone.setServe} />
      </div>
    </Block>
  );
}

/** Pairing a new phone: the button, then the code and its QR once one is minted. */
function PairBlock({ phone, status, lastCode }: { phone: PhoneApi; status: PhoneLanStatus; lastCode: PairCode | null }) {
  return (
    <Block title="Pair a phone">
      <div>
        <Setting label="A new phone" help="A code that lives ten minutes. Scan it with the phone's camera, then Add to Home Screen.">
          <Button tone="positive" onClick={phone.beginPair}>
            {lastCode ? "new code" : "pair a phone"}
          </Button>
        </Setting>
        {lastCode && <PairPlate code={lastCode} status={status} />}
      </div>
    </Block>
  );
}

/** The phones paired with this Mac, each with when it was last seen, the route it came in by, and forget. */
function PairedPhones({ devices, on, onForget }: { devices: PairedDevice[] | null; on: boolean; onForget: (id: string) => void }) {
  return (
    <Block title="Paired phones">
      {devices === null && <Setting label="Phones" help="—" />}
      {devices?.length === 0 && <Setting label="None yet" help={on ? "Pair one above." : "Switch on reaching this Mac to pair one."} />}
      {devices?.map((d) => {
        const via = viaLabel(d.last_via);
        return (
          <Setting key={d.id} label={d.name} help={via ? `${lastSeen(d.last_seen_at)} · came in via ${via}` : lastSeen(d.last_seen_at)}>
            <Button size="sm" tone="negative" onClick={() => onForget(d.id)} title="this phone has to pair again">
              forget
            </Button>
          </Setting>
        );
      })}
    </Block>
  );
}

/**
 * The route: two rows, one lit. Each names the way in and shows the address a phone uses for it, so the
 * page never has to say elsewhere what the QR carries. Without Tailscale there is one row and a line
 * on how to get the other; with it installed but signed out, the Tailscale row is there but cannot be lit.
 */
function Route({ status, onVia, onServe }: { status: PhoneLanStatus; onVia: (via: LanVia) => void; onServe: (enabled: boolean) => void }) {
  const ts = status.tailscale;
  const running = !!ts?.running;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div
        role="radiogroup"
        aria-label="route"
        style={{ display: "grid", border: "1px solid var(--loki-border)", borderRadius: "var(--loki-radius-md)", overflow: "hidden" }}
      >
        {(ts?.installed || running) && (
          <RouteRow
            via="tailscale"
            lit={status.via === "tailscale"}
            disabled={!running}
            address={running ? tailnetAddress(status) : null}
            hint={running ? "any network" : "installed, not connected: open Tailscale and sign in"}
            onPick={onVia}
          />
        )}
        <RouteRow via="lan" lit={status.via === "lan"} address={wifiAddress(status)} hint="the same Wi‑Fi only" onPick={onVia} />
      </div>
      {running && status.via === "tailscale" && <ServeSwitch ts={ts} onServe={onServe} />}
      {!ts?.installed && !running && <NoTailscale />}
    </div>
  );
}

/** Under a lit Tailscale row: the `tailscale serve` switch, and the mod's error when serve would not start. */
function ServeSwitch({ ts, onServe }: { ts: TailscaleStatus; onServe: (enabled: boolean) => void }) {
  return (
    <div style={{ display: "grid", gap: 2, paddingLeft: 2 }}>
      <Switch on={!!ts.serve_url} onToggle={() => onServe(!ts.serve_url)} label="https on the tailnet" small />
      {ts.error && (
        <div className="loki-meta loki-meta--negative loki-meta--wrap" style={{ overflowWrap: "anywhere" }}>
          {ts.error}
        </div>
      )}
    </div>
  );
}

/** The line under the route rows when Tailscale is not installed: what it would give, and where to get it. */
function NoTailscale() {
  return (
    <span className="loki-meta loki-meta--wrap" style={{ lineHeight: 1.5 }}>
      Tailscale is not on this Mac. With it on the Mac and the phone, signed in to one account, this works from any network —{" "}
      <span style={{ fontFamily: "var(--loki-mono)" }}>tailscale.com/download</span>
    </span>
  );
}

/** One route: a dot, the name, the address a phone uses, and a word on where it works. The lit one (the header tint) is what the QR carries; its dot is the accent. */
function RouteRow({
  via,
  lit,
  disabled = false,
  address,
  hint,
  onPick,
}: {
  via: LanVia;
  lit: boolean;
  disabled?: boolean;
  address: string | null;
  hint: string;
  onPick: (via: LanVia) => void;
}) {
  return (
    <PickRow
      role="radio"
      aria-checked={lit}
      aria-disabled={disabled || undefined}
      selected={lit}
      flush
      onClick={() => !disabled && onPick(via)}
      style={{ padding: "8px 12px", cursor: disabled ? "default" : undefined, opacity: disabled ? 0.5 : 1 }}
    >
      <Dot aria-hidden size={10} color={lit ? "var(--loki-accent)" : "var(--loki-border)"} ring={!lit} style={{ marginTop: 5 }} />
      <span style={{ display: "grid", gap: 1, minWidth: 0, flex: 1 }}>
        <span style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
          <span style={{ fontSize: 13.5, color: lit ? "var(--loki-fg)" : "var(--loki-muted)" }}>{ROUTE_NAME[via]}</span>
          <span className="loki-meta loki-meta--wrap">{hint}</span>
        </span>
        {address && (
          <span style={{ fontFamily: "var(--loki-mono)", fontSize: 12, color: lit ? "var(--loki-fg)" : "var(--loki-muted)", overflowWrap: "anywhere" }}>
            {address}
          </span>
        )}
      </span>
    </PickRow>
  );
}

/** The QR, the six letters, the URL as text (following the lit route), and the time left; the button above mints another. */
function PairPlate({ code, status }: { code: PairCode; status: PhoneLanStatus }) {
  const url = pairUrlFor(status, code.code) ?? code.url;
  const [svg, setSvg] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let live = true;
    // Dark on light, whatever the page: cameras read that; the SVG carries its own quiet zone as the plate.
    void QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 2 })
      .then((s) => live && setSvg(s))
      .catch((err: unknown) => console.warn("loki: qr", err));
    return () => {
      live = false;
    };
  }, [url]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = countdown(code.expiresAt, now);
  const expired = left === "expired";
  return (
    <div style={{ display: "flex", gap: 18, alignItems: "flex-start", flexWrap: "wrap", paddingBottom: 12 }}>
      <div
        aria-label={`QR code for ${url}`}
        role="img"
        style={{ width: 168, height: 168, borderRadius: "var(--loki-radius-md)", overflow: "hidden", flex: "0 0 auto", opacity: expired ? 0.35 : 1 }}
        dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
      />
      <div style={{ display: "grid", gap: 6, minWidth: 0, flex: 1 }}>
        <div style={{ fontFamily: "var(--loki-mono)", fontSize: 22, color: expired ? "var(--loki-muted)" : "var(--loki-fg)" }}>{code.code}</div>
        <div className="loki-meta loki-meta--wrap" style={{ fontFamily: "var(--loki-mono)", overflowWrap: "anywhere" }}>
          {url}
        </div>
        <div style={{ fontSize: 12, color: expired ? "var(--loki-negative)" : "var(--loki-muted)" }}>
          {expired ? "expired" : `${left} left`} · over {ROUTE_NAME[status.via]}
        </div>
        <div className="loki-meta loki-meta--wrap" style={{ lineHeight: 1.5 }}>
          The new icon asks for this code once.
        </div>
      </div>
    </div>
  );
}
