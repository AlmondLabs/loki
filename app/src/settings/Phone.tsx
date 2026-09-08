import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { btn } from "../chat/ui";
import { countdown, lastSeen, pairOrigin, type LanVia, type PairCode, type PairedDevice, type PhoneLanStatus } from "../phone/model";

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

/**
 * Settings › phone. A switch puts the mod on the Wi‑Fi (port 41415); "reach the Mac" says whether
 * Tailscale is on this Mac and, when it runs, which way the QR sends the phone; a pairing code, shown
 * as a QR and as six letters, lets a phone in for good; the list underneath is every phone that did.
 * The QR is the mod's own URL with the code as a query, so the phone's camera does the typing.
 */
export function Phone({ phone, connected }: { phone: PhoneApi; connected: boolean }) {
  const { status, devices, lastCode } = phone;
  useEffect(() => {
    if (connected) phone.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  if (!connected || !status) return <div style={{ fontSize: 12, color: "var(--loki-muted)" }}>asking the mod…</div>;
  const on = status.enabled;
  const ts = status.tailscale;
  const tailnet = !!ts?.running;
  // The name is what phones bookmark (it survives a new address on another Wi‑Fi); the address is the fallback and the check.
  const where = status.host ? `${status.host}:${status.port}${status.address ? ` (${status.address})` : ""}` : status.address ? `${status.address}:${status.port}` : `port ${status.port}`;
  // Other Wi‑Fi addresses, then the tailnet address: every way this Mac can be reached on 41415.
  const also = [...status.addresses.filter((a) => a !== status.address), ...(tailnet && ts?.ip ? [`${ts.ip} (Tailscale)`] : [])];

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <Row label="wi‑fi">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <Switch on={on} onToggle={() => phone.setEnabled(!on)} label="reachable on this Wi‑Fi" />
          {on && <span style={{ fontFamily: "var(--loki-mono)", fontSize: 12, color: "var(--loki-fg)" }}>{where}</span>}
          {on && also.length > 0 && <span style={{ fontSize: 12, color: "var(--loki-muted)" }}>also {also.join(", ")}</span>}
        </span>
        {status.error && <div style={{ fontSize: 12, color: "var(--loki-negative)", fontFamily: "var(--loki-mono)", marginTop: 4 }}>{status.error}</div>}
        {on && !status.appServed && <div style={{ fontSize: 12, color: "var(--loki-accent)", marginTop: 4 }}>the canvas build is missing; run bun run build:app</div>}
      </Row>

      {on && (
        <Row label="reach the Mac">
          <Reach status={status} onVia={phone.setVia} onServe={phone.setServe} />
        </Row>
      )}

      {on && (
        <Row label="pair">
          {lastCode ? (
            <PairPlate code={lastCode} onNew={phone.beginPair} />
          ) : (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <button type="button" onClick={phone.beginPair} style={btn("var(--loki-accent)")}>
                pair a phone
              </button>
              <span style={{ fontSize: 12, color: "var(--loki-muted)" }}>a code that lives ten minutes</span>
            </span>
          )}
        </Row>
      )}

      <Row label="phones">
        {devices === null ? (
          <span style={{ fontSize: 12, color: "var(--loki-muted)" }}>—</span>
        ) : devices.length === 0 ? (
          <span style={{ fontSize: 12, color: "var(--loki-muted)" }}>no phones yet</span>
        ) : (
          <div style={{ display: "grid", gap: 4 }}>
            {devices.map((d) => (
              <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "6px 10px", border: "1px solid var(--loki-border)", borderRadius: 8 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--loki-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</span>
                <span style={{ fontSize: 10.5, color: "var(--loki-muted)", fontFamily: "var(--loki-mono)", letterSpacing: "0.06em", whiteSpace: "nowrap" }}>last seen {lastSeen(d.lastSeenAt)}</span>
                <button type="button" onClick={() => phone.forget(d.id)} style={{ ...btn("var(--loki-negative)"), padding: "3px 8px", fontSize: 10.5 }} title="this phone has to pair again">
                  forget
                </button>
              </div>
            ))}
          </div>
        )}
      </Row>

      <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--loki-accent)", borderLeft: "2px solid var(--loki-accent)", paddingLeft: 10 }}>
        While this is on, anyone on this network can open the page and read the app's code; every action needs a paired phone; forget a phone here. Plain http on the LAN — on a network you do not trust, use Tailscale.
      </div>
    </div>
  );
}

/**
 * "reach the Mac": what Tailscale is doing on this Mac, and — while it runs — which way the QR sends
 * the phone and whether `tailscale serve` puts https in front. The tailnet works from any network;
 * the Wi‑Fi route is the fallback for a Mac without it. Nothing here waits on the human, so no brass
 * beyond the chosen pill.
 */
function Reach({ status, onVia, onServe }: { status: PhoneLanStatus; onVia: (via: LanVia) => void; onServe: (enabled: boolean) => void }) {
  const ts = status.tailscale;
  const mono: React.CSSProperties = { fontFamily: "var(--loki-mono)", fontSize: 12, color: "var(--loki-fg)" };
  if (!ts || !ts.installed) {
    return (
      <div style={{ display: "grid", gap: 4 }}>
        <span style={{ color: "var(--loki-fg)" }}>Tailscale: not on this Mac</span>
        <span style={{ fontSize: 12, color: "var(--loki-muted)", lineHeight: 1.5 }}>
          Install Tailscale on the Mac and on the phone, sign in to the same account, and this works on any network — <span style={{ fontFamily: "var(--loki-mono)" }}>tailscale.com/download</span>
        </span>
      </div>
    );
  }
  if (!ts.running) return <span style={{ color: "var(--loki-fg)" }}>Tailscale: installed, not connected</span>;
  const serving = !!ts.serveUrl;
  const carries = pairOrigin(status);
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <span style={{ color: "var(--loki-fg)", overflowWrap: "anywhere" }}>
        Tailscale: <span style={mono}>{ts.name ?? "—"}</span> <span style={{ ...mono, color: "var(--loki-muted)" }}>· {ts.ip ?? "—"}</span>
      </span>
      <div style={{ display: "grid", gap: 4 }}>
        <Choice options={["tailscale", "lan"] as LanVia[]} value={status.via} onPick={onVia} labels={{ tailscale: "Tailscale", lan: "this Wi‑Fi" }} />
        <span style={{ fontSize: 12, color: "var(--loki-muted)" }}>
          the QR carries <span style={{ fontFamily: "var(--loki-mono)", color: "var(--loki-fg)" }}>{carries ?? "nothing yet"}</span>
        </span>
      </div>
      <div style={{ display: "grid", gap: 4 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <Switch on={serving} onToggle={() => onServe(!serving)} label="serve over Tailscale (https)" />
          {ts.serveUrl && <span style={mono}>{ts.serveUrl}</span>}
        </span>
        {ts.error && <div style={{ fontSize: 12, color: "var(--loki-negative)", fontFamily: "var(--loki-mono)", overflowWrap: "anywhere" }}>{ts.error}</div>}
        <span style={{ fontSize: 12, color: "var(--loki-muted)", lineHeight: 1.5 }}>tailnet only, never Funnel; needs HTTPS certificates enabled for your tailnet</span>
      </div>
    </div>
  );
}

/** Two or three pills, one lit — the same control the desktop's chat placement uses. */
function Choice<T extends string>({ options, value, onPick, labels = {} }: { options: T[]; value: T; onPick: (v: T) => void; labels?: Partial<Record<T, string>> }) {
  return (
    <span style={{ display: "inline-flex", gap: 6 }}>
      {options.map((o) => (
        <button key={o} type="button" onClick={() => onPick(o)} aria-pressed={value === o} className="loki-label" style={{ padding: "4px 10px", border: `1px solid ${value === o ? "var(--loki-accent)" : "var(--loki-border)"}`, background: value === o ? "var(--loki-brass-soft)" : "transparent", color: value === o ? "var(--loki-accent)" : "var(--loki-muted)", cursor: "pointer", fontSize: 10.5 }}>
          {labels[o] ?? o}
        </button>
      ))}
    </span>
  );
}

/** The QR, the six letters, the URL as text, and the time left; "new code" mints another. */
function PairPlate({ code, onNew }: { code: PairCode; onNew: () => void }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let live = true;
    // Dark on light, whatever the page: cameras read that; the SVG carries its own quiet zone as the plate.
    void QRCode.toString(code.url, { type: "svg", errorCorrectionLevel: "M", margin: 2 }).then((s) => live && setSvg(s)).catch((err) => console.warn("loki: qr", err));
    return () => {
      live = false;
    };
  }, [code.url]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = countdown(code.expiresAt, now);
  const expired = left === "expired";
  return (
    <div style={{ display: "flex", gap: 18, alignItems: "flex-start", flexWrap: "wrap" }}>
      <div aria-label={`QR code for ${code.url}`} role="img" style={{ width: 168, height: 168, borderRadius: 8, overflow: "hidden", flex: "0 0 auto", opacity: expired ? 0.35 : 1 }} dangerouslySetInnerHTML={svg ? { __html: svg } : undefined} />
      <div style={{ display: "grid", gap: 6, minWidth: 0, flex: 1 }}>
        <div style={{ fontFamily: "var(--loki-mono)", fontSize: 22, letterSpacing: "0.14em", color: expired ? "var(--loki-muted)" : "var(--loki-fg)" }}>{code.code}</div>
        <div style={{ fontFamily: "var(--loki-mono)", fontSize: 12, color: "var(--loki-muted)", overflowWrap: "anywhere" }}>{code.url}</div>
        <div style={{ fontSize: 12, color: expired ? "var(--loki-negative)" : "var(--loki-muted)", fontFamily: "var(--loki-mono)", letterSpacing: "0.06em" }}>{expired ? "expired" : `${left} left`}</div>
        <div style={{ fontSize: 12, color: "var(--loki-muted)", lineHeight: 1.5 }}>Scan with the phone's camera, then Add to Home Screen. The new icon asks for this code once.</div>
        <div>
          <button type="button" onClick={onNew} style={btn(expired ? "var(--loki-accent)" : undefined)}>
            new code
          </button>
        </div>
      </div>
    </div>
  );
}

function Switch({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={onToggle} style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "transparent", border: "none", padding: 0, cursor: "pointer", color: on ? "var(--loki-fg)" : "var(--loki-muted)", fontSize: 13.5 }}>
      <span aria-hidden style={{ width: 28, height: 16, borderRadius: 999, background: on ? "var(--loki-accent)" : "var(--loki-border)", position: "relative", transition: "background 160ms ease-out", flex: "0 0 auto" }}>
        <span style={{ position: "absolute", top: 2, left: on ? 14 : 2, width: 12, height: 12, borderRadius: 6, background: on ? "var(--loki-bg)" : "var(--loki-muted)", transition: "left 160ms ease-out" }} />
      </span>
      {label}
    </button>
  );
}

/** A labelled row in the style of Settings' facts (the label column matches). */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 12, alignItems: "start", fontSize: 13.5, lineHeight: 1.5 }}>
      <span className="loki-label" style={{ fontSize: 9.5, paddingTop: 4 }}>{label}</span>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}
