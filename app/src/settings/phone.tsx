import { useEffect, useEffectEvent, useState } from "react";
import QRCode from "qrcode";
import { Button, Dot, Row as PickRow, Switch, sentence } from "../components";
import { Block, Setting } from "./layout";
import { useNow } from "../components/use-now";
import { notYetOn, platform, type Platform } from "../desk/env";
import { countdown, lastSeen, pairUrlFor, tailnetAddress, viaLabel, wifiAddress, type PairCode, type PairedDevice, type PhoneLanStatus } from "../phone/model";
import type { LanVia, TailscaleStatus } from "../../../core/frame-types.ts";

export interface PhoneApi {
  status: PhoneLanStatus | null;
  devices: PairedDevice[] | null;
  lastCode: PairCode | null;
  refresh: () => void;
  setEnabled: (enabled: boolean) => void;
  setVia: (via: LanVia) => void;
  setServe: (enabled: boolean) => void;
  beginPair: () => void;
  forget: (id: string) => void;
}

const ROUTE_NAME: Record<LanVia, string> = { tailscale: "Tailscale", lan: "this Wi‑Fi" };

export function Phone({ phone, connected, os = platform }: { phone: PhoneApi; connected: boolean; os?: Platform }) {
  const { status, devices, lastCode } = phone;
  const here = os === "macos";
  const refresh = useEffectEvent(() => phone.refresh());
  useEffect(() => {
    if (connected && here) refresh();
  }, [connected, here]);

  if (!here) return <Setting label="Phone" help={notYetOn("Phone pairing", os)} />;
  if (!connected || !status) return <Setting label="Phone" help="Asking the mod…" />;
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

function ReachBlock({ phone, status }: { phone: PhoneApi; status: PhoneLanStatus }) {
  const on = status.enabled;
  return (
    <Block>
      <Setting
        label="Phones can reach this Mac"
        help={
          <>
            The inbox and your chats on a phone, over Tailscale or this Wi‑Fi; nothing to install.
            {status.error && <span className="loki-meta--negative block">{status.error}</span>}
            {on && !status.app_served && <span className="loki-meta--negative block">The canvas build is missing; run npm run build:app.</span>}
          </>
        }
      >
        <Switch on={on} onToggle={() => phone.setEnabled(!on)} label="Phones can reach this Mac" hideLabel />
      </Setting>
    </Block>
  );
}

function RouteBlock({ phone, status }: { phone: PhoneApi; status: PhoneLanStatus }) {
  const safety =
    status.via === "lan"
      ? "Only a paired phone can act, but this Wi‑Fi sees plain http, so use Tailscale on a network you do not trust."
      : "Only a paired phone can act, and the tailnet is yours alone.";
  return (
    <Block title="Route" help={safety}>
      <div style={{ padding: "12px 0" }}>
        <Route status={status} onVia={phone.setVia} onServe={phone.setServe} />
      </div>
    </Block>
  );
}

function PairBlock({ phone, status, lastCode }: { phone: PhoneApi; status: PhoneLanStatus; lastCode: PairCode | null }) {
  return (
    <Block title="Pair a phone">
      <div>
        <Setting label="A new phone" help="Scan the code with the phone's camera within ten minutes, then Add to Home Screen.">
          <Button tone="positive" onClick={phone.beginPair}>
            {lastCode ? "New Code" : "Pair Phone"}
          </Button>
        </Setting>
        {lastCode && <PairPlate code={lastCode} status={status} />}
      </div>
    </Block>
  );
}

function PairedPhones({ devices, on, onForget }: { devices: PairedDevice[] | null; on: boolean; onForget: (id: string) => void }) {
  return (
    <Block title="Paired phones">
      {devices === null && <Setting label="Phones" help="—" />}
      {devices?.length === 0 && <Setting label="None yet" help={on ? "Pair one above." : "Switch on reaching this Mac to pair one."} />}
      {devices?.map((d) => {
        const via = viaLabel(d.last_via);
        return (
          <Setting key={d.id} label={d.name} help={sentence(via ? `${lastSeen(d.last_seen_at)} · came in via ${via}` : lastSeen(d.last_seen_at))}>
            <Button size="sm" tone="negative" onClick={() => onForget(d.id)} title="This phone has to pair again">
              Forget
            </Button>
          </Setting>
        );
      })}
    </Block>
  );
}

function Route({ status, onVia, onServe }: { status: PhoneLanStatus; onVia: (via: LanVia) => void; onServe: (enabled: boolean) => void }) {
  const ts = status.tailscale;
  const running = !!ts?.running;
  return (
    <div className="grid gap-2">
      <div
        role="radiogroup"
        aria-label="Route"
        className="grid"
        style={{ border: "1px solid var(--loki-border)", borderRadius: "var(--radius-lg)", overflow: "hidden" }}
      >
        {(ts?.installed || running) && (
          <RouteRow
            via="tailscale"
            lit={status.via === "tailscale"}
            disabled={!running}
            address={running ? tailnetAddress(status) : null}
            hint={running ? "Any network" : "Installed, not connected: open Tailscale and sign in"}
            onPick={onVia}
          />
        )}
        <RouteRow via="lan" lit={status.via === "lan"} address={wifiAddress(status)} hint="The same Wi‑Fi only" onPick={onVia} />
      </div>
      {running && status.via === "tailscale" && <ServeSwitch ts={ts} onServe={onServe} />}
      {!ts?.installed && !running && <NoTailscale />}
    </div>
  );
}

function ServeSwitch({ ts, onServe }: { ts: TailscaleStatus; onServe: (enabled: boolean) => void }) {
  return (
    <div className="grid gap-0.5" style={{ paddingLeft: 2 }}>
      <Switch on={!!ts.serve_url} onToggle={() => onServe(!ts.serve_url)} label="HTTPS on the tailnet" small />
      {ts.error && (
        <div className="loki-meta loki-meta--negative loki-meta--wrap" style={{ overflowWrap: "anywhere" }}>
          {ts.error}
        </div>
      )}
    </div>
  );
}

function NoTailscale() {
  return (
    <span className="loki-meta loki-meta--wrap" style={{ lineHeight: 1.5 }}>
      Tailscale is not on this Mac. With it on the Mac and the phone, signed in to one account, this works from any network —{" "}
      <span className="loki-mono">tailscale.com/download</span>
    </span>
  );
}

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
      <Dot aria-hidden size={10} color={lit ? "var(--loki-accent)" : "var(--loki-border)"} ring={!lit} style={{ marginTop: 4 }} />
      <span className="grid gap-px min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-2">
          <span style={{ fontSize: "var(--text-sm)", color: lit ? "var(--loki-fg)" : "var(--loki-muted)" }}>{sentence(ROUTE_NAME[via])}</span>
          <span className="loki-meta loki-meta--wrap">{hint}</span>
        </span>
        {address && (
          <span
            className="loki-mono"
            style={{
              fontSize: "var(--text-xs)",
              color: lit ? "var(--loki-fg)" : "var(--loki-muted)",
              overflowWrap: "anywhere",
            }}
          >
            {address}
          </span>
        )}
      </span>
    </PickRow>
  );
}

function PairPlate({ code, status }: { code: PairCode; status: PhoneLanStatus }) {
  const url = pairUrlFor(status, code.code) ?? code.url;
  const [svg, setSvg] = useState<string | null>(null);
  const now = useNow(1000);
  useEffect(() => {
    let live = true;
    void QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 2 })
      .then((s) => live && setSvg(s))
      .catch((err: unknown) => console.warn("loki: qr", err));
    return () => {
      live = false;
    };
  }, [url]);
  const left = countdown(code.expiresAt, now);
  const expired = left === "expired";
  return (
    <div className="flex flex-wrap items-start gap-4" style={{ paddingBottom: 12 }}>
      <div
        aria-label={`QR code for ${url}`}
        role="img"
        className="flex-none"
        style={{ width: 168, height: 168, borderRadius: "var(--radius-lg)", overflow: "hidden", opacity: expired ? 0.35 : 1 }}
        dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
      />
      <div className="grid gap-2 min-w-0 flex-1">
        <div className="loki-mono" style={{ fontSize: "var(--text-2xl)", color: expired ? "var(--loki-muted)" : "var(--loki-fg)" }}>
          {code.code}
        </div>
        <div className="loki-meta loki-meta--wrap loki-mono" style={{ overflowWrap: "anywhere" }}>
          {url}
        </div>
        <div style={{ fontSize: "var(--text-xs)", color: expired ? "var(--loki-negative)" : "var(--loki-muted)" }}>
          {expired ? "Expired" : `${left} left`} · over {ROUTE_NAME[status.via]}
        </div>
        <div className="loki-meta loki-meta--wrap" style={{ lineHeight: 1.5 }}>
          The new icon asks for this code once.
        </div>
      </div>
    </div>
  );
}
