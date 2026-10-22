import { useEffect, useEffectEvent, useState } from "react";
import { Button, Chip, Dot, Field, Row as PickRow } from "../components";
import { useNow } from "../components/use-now";
import { countdown, lastSeen } from "../phone/model";
import { osWords } from "../shell/os-words";
import { Block, Setting } from "./layout";
import type { Pushes } from "../../../core/frames.ts";
import type { TailnetDevice } from "../../../core/frame-types.ts";

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
  if (!connected || !view) return <Setting label="Macs" help="asking the mod…" />;
  return (
    <>
      <Block help="your other Macs running loki, over your tailnet only, never the Wi‑Fi or the internet. Each chat runs on one Mac; the others reach it through that Mac.">
        <Setting
          label={osWords().Machine}
          help={
            view.me.host ? (
              <>
                {view.me.name} · <span style={{ fontFamily: "var(--loki-mono)" }}>{view.me.host}</span>
              </>
            ) : (
              `${view.me.name}, not on a tailnet: open Tailscale and sign in to pair Macs.`
            )
          }
        />
      </Block>
      <Block title="Paired Macs">
        <PairedMacs peers={view.peers} onForget={macs.forget} />
      </Block>
      <Block title="Pair a Mac">
        <Pair macs={macs} />
      </Block>
    </>
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
    <>
      <div>
        <Setting label={`From ${osWords().machine}`} help="Show a code here, and type it on the other Mac.">
          <Button tone="positive" onClick={macs.beginPair}>
            {macs.lastCode ? "new code" : "show a code"}
          </Button>
        </Setting>
        {macs.lastCode && <PairCode code={macs.lastCode} />}
      </div>
      <div style={{ display: "grid", gap: 10, paddingBottom: 12 }}>
        <Setting label="From the other Mac" help="Pick it on your tailnet, or type its address, then the code it shows." />
        <TailnetList devices={macs.view?.tailnet ?? []} picked={host} onPick={setHost} />
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
    </>
  );
}

/**
 * The other computers on your tailnet, from Tailscale (plan 023): pick the Mac to pair with and its address fills in,
 * so only its code is typed. An offline one is listed but not picked; one already paired says so.
 */
function TailnetList({ devices, picked, onPick }: { devices: Array<TailnetDevice & { paired: boolean }>; picked: string; onPick: (address: string) => void }) {
  if (devices.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <span className="loki-meta">on your tailnet · pick the other Mac, then type the code it shows</span>
      <div role="radiogroup" aria-label="computers on your tailnet" style={{ display: "grid", gap: 4 }}>
        {devices.map((d) => {
          const chosen = picked.trim().toLowerCase() === d.address;
          return (
            <PickRow
              key={d.address}
              role="radio"
              aria-checked={chosen}
              aria-disabled={!d.online || d.paired || undefined}
              selected={chosen}
              flush
              onClick={() => d.online && !d.paired && onPick(d.address)}
              style={{
                padding: "6px 10px",
                border: "1px solid var(--loki-border)",
                borderRadius: "var(--loki-radius-md)",
                cursor: d.online && !d.paired ? undefined : "default",
                opacity: d.online && !d.paired ? 1 : 0.55,
              }}
            >
              <Dot aria-hidden size={8} color={d.online ? "var(--loki-positive)" : "var(--loki-border)"} ring={!d.online} />
              <span style={{ display: "grid", minWidth: 0, flex: 1 }}>
                <span style={{ fontSize: 13.5, color: "var(--loki-fg)" }}>{d.name}</span>
                <span className="loki-meta" style={{ fontFamily: "var(--loki-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {d.address}
                </span>
              </span>
              <span className="loki-meta">{d.paired ? "paired" : d.online ? d.os : "offline"}</span>
            </PickRow>
          );
        })}
      </div>
    </div>
  );
}

/** The code, the address to type beside it, and the time left; the button above mints another. */
function PairCode({ code }: { code: Pushes["peer_pair_code"] }) {
  const now = useNow(1000);
  const left = countdown(code.expires_at, now);
  const expired = left === "expired";
  return (
    <div style={{ display: "grid", gap: 4, paddingBottom: 12 }}>
      <div style={{ fontFamily: "var(--loki-mono)", fontSize: 22, color: expired ? "var(--loki-muted)" : "var(--loki-fg)" }}>{code.code}</div>
      {code.host && (
        <div className="loki-meta loki-meta--wrap" style={{ fontFamily: "var(--loki-mono)", overflowWrap: "anywhere" }}>
          {code.host}
        </div>
      )}
      <div style={{ fontSize: 12, color: expired ? "var(--loki-negative)" : "var(--loki-muted)" }}>
        {expired ? "expired" : `${left} left`} · type both on the other Mac's Preferences › Macs
      </div>
    </div>
  );
}

/** The Macs paired with this one: name, when last heard from, a note when one needs an update, and forget. */
function PairedMacs({ peers, onForget }: { peers: Pushes["peers"]["peers"]; onForget: (macId: string) => void }) {
  const now = useNow();
  if (peers.length === 0) return <Setting label="None yet" help="Pair one below." />;
  return (
    <>
      {peers.map((p) => (
        <Setting
          key={p.mac_id}
          label={p.name}
          help={
            <>
              <span style={{ fontFamily: "var(--loki-mono)" }}>{p.host}</span> · {p.reachable ? "connected" : `out of reach, ${lastSeen(p.last_seen_at, now)}`}
            </>
          }
        >
          {p.outdated && (
            <Chip static label title={`${osWords().machine} and that one run different loki versions: nothing syncs until both are updated`}>
              needs an update
            </Chip>
          )}
          <Button size="sm" tone="negative" onClick={() => onForget(p.mac_id)} title="both Macs forget each other; pair again to reconnect">
            forget
          </Button>
        </Setting>
      ))}
    </>
  );
}
