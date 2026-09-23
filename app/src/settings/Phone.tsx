import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Button, Chip, Dot, Row as PickRow, Switch } from "../components";
import { countdown, lastSeen, pairUrlFor, tailnetAddress, viaLabel, wifiAddress, type LanVia, type PairCode, type PairedDevice, type PhoneLanStatus, type TailscaleStatus } from "../phone/model";

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
 * Settings › phone, in four rows that answer four questions. Is the Mac reachable (a switch). Which way do
 * phones come in (the route: one lit row, Tailscale or this Wi‑Fi; the lit one is what the QR carries and
 * what a new phone bookmarks). How does a new phone join (the QR, whose URL follows the lit route). Which
 * phones are in, and which way did each one last arrive (the list). Nothing else is on the page: the
 * addresses that used to be listed live inside the route rows now, one per route.
 */
export function Phone({ phone, connected }: { phone: PhoneApi; connected: boolean }) {
  const { status, devices, lastCode } = phone;
  useEffect(() => {
    if (connected) phone.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  if (!connected || !status) return <div style={{ fontSize: 12, color: "var(--loki-muted)" }}>asking the mod…</div>;
  const on = status.enabled;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Row label="Phone">
        <Switch on={on} onToggle={() => phone.setEnabled(!on)} label="phones can reach this Mac" />
        {status.error && <div style={{ fontSize: 12, color: "var(--loki-negative)", marginTop: 4 }}>{status.error}</div>}
        {on && !status.appServed && <div style={{ fontSize: 12, color: "var(--loki-negative)", marginTop: 4 }}>the canvas build is missing; run bun run build:app</div>}
      </Row>

      {on && (
        <Row label="Route">
          <Route status={status} onVia={phone.setVia} onServe={phone.setServe} />
        </Row>
      )}

      {on && (
        <Row label="Pair">
          {lastCode ? (
            <PairPlate code={lastCode} status={status} onNew={phone.beginPair} />
          ) : (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <Button size="sm" tone="positive" onClick={phone.beginPair}>
                pair a phone
              </Button>
              <span style={{ fontSize: 12, color: "var(--loki-muted)" }}>a code that lives ten minutes</span>
            </span>
          )}
        </Row>
      )}

      <Row label="Phones">
        {devices === null ? (
          <span style={{ fontSize: 12, color: "var(--loki-muted)" }}>—</span>
        ) : devices.length === 0 ? (
          <span style={{ fontSize: 12, color: "var(--loki-muted)" }}>no phones yet</span>
        ) : (
          <div style={{ display: "grid", gap: 4 }}>
            {devices.map((d) => {
              const via = viaLabel(d.lastVia);
              return (
                <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "6px 10px", border: "1px solid var(--loki-border)", borderRadius: 8 }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--loki-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</span>
                  {via && (
                    <Chip static label title="the route this phone's last request came in by">
                      via {via}
                    </Chip>
                  )}
                  <span style={{ fontSize: 10.5, color: "var(--loki-muted)", whiteSpace: "nowrap" }}>{lastSeen(d.lastSeenAt)}</span>
                  <Button size="sm" tone="negative" onClick={() => phone.forget(d.id)} title="this phone has to pair again">
                    forget
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </Row>

      {on && (
        <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--loki-muted)" }}>
          Anyone on the lit route can open the page; only a paired phone can act. {status.via === "lan" ? "Plain http on this Wi‑Fi: on a network you do not trust, use Tailscale." : "The tailnet is yours alone; Funnel is never used."}
        </div>
      )}
    </div>
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
      <div role="radiogroup" aria-label="route" style={{ display: "grid", border: "1px solid var(--loki-border)", borderRadius: 8, overflow: "hidden" }}>
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
      {running && status.via === "tailscale" && <ServeSwitch ts={ts!} onServe={onServe} />}
      {!ts?.installed && !running && <NoTailscale />}
    </div>
  );
}

/** Under a lit Tailscale row: the `tailscale serve` switch, and the mod's error when serve would not start. */
function ServeSwitch({ ts, onServe }: { ts: TailscaleStatus; onServe: (enabled: boolean) => void }) {
  return (
    <div style={{ display: "grid", gap: 2, paddingLeft: 2 }}>
      <Switch on={!!ts.serveUrl} onToggle={() => onServe(!ts.serveUrl)} label="https on the tailnet" small />
      {ts.error && <div style={{ fontSize: 12, color: "var(--loki-negative)", overflowWrap: "anywhere" }}>{ts.error}</div>}
    </div>
  );
}

/** The line under the route rows when Tailscale is not installed: what it would give, and where to get it. */
function NoTailscale() {
  return (
    <span style={{ fontSize: 12, color: "var(--loki-muted)", lineHeight: 1.5 }}>
      Tailscale is not on this Mac. With it on the Mac and the phone, signed in to one account, this works from any network — <span style={{ fontFamily: "var(--loki-mono)" }}>tailscale.com/download</span>
    </span>
  );
}

/** One route: a dot, the name, the address a phone uses, and a word on where it works. The lit one (the header tint) is what the QR carries; its dot is the accent. */
function RouteRow({ via, lit, disabled = false, address, hint, onPick }: { via: LanVia; lit: boolean; disabled?: boolean; address: string | null; hint: string; onPick: (via: LanVia) => void }) {
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
          <span style={{ fontSize: 10.5, color: "var(--loki-muted)" }}>{hint}</span>
        </span>
        {address && <span style={{ fontFamily: "var(--loki-mono)", fontSize: 12, color: lit ? "var(--loki-fg)" : "var(--loki-muted)", overflowWrap: "anywhere" }}>{address}</span>}
      </span>
    </PickRow>
  );
}

/** The QR, the six letters, the URL as text (following the lit route), and the time left; "new code" mints another. */
function PairPlate({ code, status, onNew }: { code: PairCode; status: PhoneLanStatus; onNew: () => void }) {
  const url = pairUrlFor(status, code.code) ?? code.url;
  const [svg, setSvg] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let live = true;
    // Dark on light, whatever the page: cameras read that; the SVG carries its own quiet zone as the plate.
    void QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 2 }).then((s) => live && setSvg(s)).catch((err) => console.warn("loki: qr", err));
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
    <div style={{ display: "flex", gap: 18, alignItems: "flex-start", flexWrap: "wrap" }}>
      <div aria-label={`QR code for ${url}`} role="img" style={{ width: 168, height: 168, borderRadius: 8, overflow: "hidden", flex: "0 0 auto", opacity: expired ? 0.35 : 1 }} dangerouslySetInnerHTML={svg ? { __html: svg } : undefined} />
      <div style={{ display: "grid", gap: 6, minWidth: 0, flex: 1 }}>
        <div style={{ fontFamily: "var(--loki-mono)", fontSize: 22, color: expired ? "var(--loki-muted)" : "var(--loki-fg)" }}>{code.code}</div>
        <div style={{ fontFamily: "var(--loki-mono)", fontSize: 12, color: "var(--loki-muted)", overflowWrap: "anywhere" }}>{url}</div>
        <div style={{ fontSize: 12, color: expired ? "var(--loki-negative)" : "var(--loki-muted)" }}>
          {expired ? "expired" : `${left} left`} · over {ROUTE_NAME[status.via]}
        </div>
        <div style={{ fontSize: 12, color: "var(--loki-muted)", lineHeight: 1.5 }}>Scan with the phone's camera, then Add to Home Screen. The new icon asks for this code once.</div>
        <div>
          <Button size="sm" tone={expired ? "brass" : "quiet"} onClick={onNew}>
            new code
          </Button>
        </div>
      </div>
    </div>
  );
}


/** A labelled row in the style of Settings' facts (the label column matches). */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 12, alignItems: "start", fontSize: 13.5, lineHeight: 1.5 }}>
      <span className="loki-label" style={{ paddingTop: 4 }}>{label}</span>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}
