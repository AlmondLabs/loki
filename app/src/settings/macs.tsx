import { useEffect, useEffectEvent, useState } from "react";
import { Button, Chip, Field } from "../components";
import { useNow } from "../components/use-now";
import { countdown, lastSeen } from "../phone/model";
import { osWords } from "../shell/os-words";
import type { Pushes } from "../../../core/frames.ts";

/** What useDesk exposes as `macs`: this Mac, the Macs paired with it, the last code minted here, and the actions. */
export interface MacsApi {
  view: Pushes["peers"] | null;
  lastCode: Pushes["peer_pair_code"] | null;
  refresh: () => void;
  beginPair: () => void;
  /** Pair with the Mac at `host` using its code; resolves with null, or the reason it did not pair. */
  join: (host: string, code: string) => Promise<string | null>;
  forget: (macId: string) => void;
}

/**
 * Settings › Macs (plan 023, U1): this Mac's name and tailnet address, the two halves of pairing (show a code here, or
 * type another Mac's address and code), and the Macs paired with this one. Pairing is mutual: either side can forget
 * the other, and both stop.
 */
export function Macs({ macs, connected }: { macs: MacsApi; connected: boolean }) {
  const refresh = useEffectEvent(() => macs.refresh());
  useEffect(() => {
    if (connected) refresh();
  }, [connected]);

  const view = macs.view;
  if (!connected || !view) return <div className="loki-meta loki-meta--wrap">asking the mod…</div>;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Row label={osWords().Machine}>
        <span style={{ display: "grid", gap: 2 }}>
          <span style={{ fontSize: 13.5, color: "var(--loki-fg)" }}>{view.me.name}</span>
          {view.me.host ? (
            <span className="loki-meta loki-meta--wrap" style={{ fontFamily: "var(--loki-mono)" }}>
              {view.me.host}
            </span>
          ) : (
            <span className="loki-meta loki-meta--wrap">not on a tailnet: open Tailscale and sign in to pair Macs</span>
          )}
        </span>
      </Row>
      <Row label="Pair">
        <Pair macs={macs} />
      </Row>
      <Row label="Macs">
        <PairedMacs peers={view.peers} onForget={macs.forget} />
      </Row>
      <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--loki-muted)" }}>
        Macs talk to each other over your tailnet only, never the Wi‑Fi or the internet. Each chat runs on one Mac; the others reach it through that Mac.
      </div>
    </div>
  );
}

/** Both halves of pairing: a code to show here, or the other Mac's address and code typed here. */
function Pair({ macs }: { macs: MacsApi }) {
  const [host, setHost] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const join = () => {
    setBusy(true);
    setError(null);
    void macs.join(host, code).then((why) => {
      setBusy(false);
      setError(why);
      if (!why) {
        setHost("");
        setCode("");
      }
    });
  };
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {macs.lastCode ? (
        <PairCode code={macs.lastCode} onNew={macs.beginPair} />
      ) : (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          <Button size="sm" tone="positive" onClick={macs.beginPair}>
            show a code
          </Button>
          <span className="loki-meta loki-meta--wrap">type it on the other Mac</span>
        </span>
      )}
      <form
        style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (host.trim() && code.trim() && !busy) join();
        }}
      >
        <Field
          size="sm"
          mono
          aria-label="the other Mac's tailnet address"
          placeholder="the other Mac's address"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          style={{ flex: "1 1 220px", minWidth: 0 }}
        />
        <Field size="sm" mono aria-label="its pairing code" placeholder="code" value={code} onChange={(e) => setCode(e.target.value)} style={{ width: 96 }} />
        <Button size="sm" type="submit" disabled={busy || !host.trim() || !code.trim()}>
          {busy ? "pairing…" : "pair"}
        </Button>
      </form>
      {error && <div className="loki-meta loki-meta--negative loki-meta--wrap">{error}</div>}
    </div>
  );
}

/** The code, the address to type beside it, and the time left; "new code" mints another. */
function PairCode({ code, onNew }: { code: Pushes["peer_pair_code"]; onNew: () => void }) {
  const now = useNow(1000);
  const left = countdown(code.expires_at, now);
  const expired = left === "expired";
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ fontFamily: "var(--loki-mono)", fontSize: 22, color: expired ? "var(--loki-muted)" : "var(--loki-fg)" }}>{code.code}</div>
      {code.host && (
        <div className="loki-meta loki-meta--wrap" style={{ fontFamily: "var(--loki-mono)", overflowWrap: "anywhere" }}>
          {code.host}
        </div>
      )}
      <div style={{ fontSize: 12, color: expired ? "var(--loki-negative)" : "var(--loki-muted)" }}>
        {expired ? "expired" : `${left} left`} · type both on the other Mac's Settings › Macs
      </div>
      <div>
        <Button size="sm" tone={expired ? "brass" : "quiet"} onClick={onNew}>
          new code
        </Button>
      </div>
    </div>
  );
}

/** The Macs paired with this one: name, when last heard from, a note when one needs an update, and forget. */
function PairedMacs({ peers, onForget }: { peers: Pushes["peers"]["peers"]; onForget: (macId: string) => void }) {
  const now = useNow();
  if (peers.length === 0) return <span className="loki-meta loki-meta--wrap">no other Macs yet</span>;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      {peers.map((p) => (
        <div
          key={p.mac_id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "6px 10px",
            border: "1px solid var(--loki-border)",
            borderRadius: "var(--loki-radius-md)",
          }}
        >
          <span style={{ flex: 1, minWidth: 0, display: "grid" }}>
            <span style={{ fontSize: 13.5, color: "var(--loki-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
            <span className="loki-meta" style={{ fontFamily: "var(--loki-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {p.host}
            </span>
          </span>
          {p.outdated && (
            <Chip static label title={`${osWords().machine} and that one run different loki versions: nothing syncs until both are updated`}>
              needs an update
            </Chip>
          )}
          <span className="loki-meta">{lastSeen(p.last_seen_at, now)}</span>
          <Button size="sm" tone="negative" onClick={() => onForget(p.mac_id)} title="both Macs forget each other; pair again to reconnect">
            forget
          </Button>
        </div>
      ))}
    </div>
  );
}

/** A labelled row in the style of Settings' facts (the label column matches Settings › Phone). */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 12, alignItems: "start", fontSize: 13.5, lineHeight: 1.5 }}>
      <span className="loki-label" style={{ paddingTop: 4 }}>
        {label}
      </span>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}
