import { useEffect, useEffectEvent, useState } from "react";
import { Button, Chip, Dot, Field, Row as PickRow } from "../components";
import { useNow } from "../components/use-now";
import { countdown, lastSeen } from "../shared/lan-model";
import { osWords } from "../shell/os-words";
import { Block, Setting } from "./layout";
import type { Pushes } from "../../../core/frames.ts";
import type { TailnetDevice } from "../../../core/frame-types.ts";

export interface MacsApi {
  view: Pushes["peers"] | null;
  lastCode: Pushes["peer_pair_code"] | null;
  refresh: () => void;
  beginPair: () => void;
  join: (host: string, code: string) => Promise<string | null>;
  forget: (macId: string) => void;
}

export function Macs({ macs, connected }: { macs: MacsApi; connected: boolean }) {
  const refresh = useEffectEvent(() => macs.refresh());
  useEffect(() => {
    if (connected) refresh();
  }, [connected]);

  const view = macs.view;
  if (!connected || !view) return <Setting label="Macs" help="Asking the mod…" />;
  return (
    <>
      <Block help="Your other Macs running loki, reached over your tailnet only, never the Wi‑Fi or the internet.">
        <Setting
          label={osWords().Machine}
          help={
            view.me.host ? (
              <>
                {view.me.name} · <span className="loki-mono">{view.me.host}</span>
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
            {macs.lastCode ? "New Code" : "Show Code"}
          </Button>
        </Setting>
        {macs.lastCode && <PairCode code={macs.lastCode} />}
      </div>
      <div className="grid gap-3" style={{ paddingBottom: 12 }}>
        <Setting label="From the other Mac" help="Pick it on your tailnet, or type its address, then the code it shows." />
        <TailnetList devices={macs.view?.tailnet ?? []} picked={host} onPick={setHost} />
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (host.trim() && code.trim() && !busy) join();
          }}
        >
          <Field
            size="sm"
            mono
            aria-label="The other Mac's tailnet address"
            placeholder="The other Mac's address"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            className="flex-[1_1_220px] min-w-0"
          />
          <Field size="sm" mono aria-label="Its pairing code" placeholder="Code" value={code} onChange={(e) => setCode(e.target.value)} style={{ width: 96 }} />
          <Button size="sm" type="submit" disabled={busy || !host.trim() || !code.trim()}>
            {busy ? "Pairing…" : "Pair"}
          </Button>
        </form>
        {error && (
          <div role="alert" className="loki-meta loki-meta--negative loki-meta--wrap">
            {error}
          </div>
        )}
      </div>
    </>
  );
}

function TailnetList({ devices, picked, onPick }: { devices: Array<TailnetDevice & { paired: boolean }>; picked: string; onPick: (address: string) => void }) {
  if (devices.length === 0) return null;
  return (
    <div className="grid gap-1">
      <span className="loki-meta">On your tailnet · pick the other Mac, then type the code it shows</span>
      <div role="radiogroup" aria-label="Computers on your tailnet" className="grid gap-1">
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
                padding: "4px 12px",
                border: "1px solid var(--loki-border)",
                borderRadius: "var(--radius-lg)",
                cursor: d.online && !d.paired ? undefined : "default",
                opacity: d.online && !d.paired ? 1 : 0.55,
              }}
            >
              <Dot aria-hidden size={8} color={d.online ? "var(--loki-positive)" : "var(--loki-border)"} ring={!d.online} />
              <span className="grid min-w-0 flex-1">
                <span style={{ fontSize: "var(--text-sm)", color: "var(--loki-fg)" }}>{d.name}</span>
                <span className="loki-meta loki-mono">{d.address}</span>
              </span>
              <span className="loki-meta">{d.paired ? "Paired" : d.online ? d.os : "Offline"}</span>
            </PickRow>
          );
        })}
      </div>
    </div>
  );
}

function PairCode({ code }: { code: Pushes["peer_pair_code"] }) {
  const now = useNow(1000);
  const left = countdown(code.expires_at, now);
  const expired = left === "expired";
  return (
    <div className="grid gap-1" style={{ paddingBottom: 12 }}>
      <div className="loki-mono" style={{ fontSize: "var(--text-2xl)", color: expired ? "var(--loki-muted)" : "var(--loki-fg)" }}>
        {code.code}
      </div>
      {code.host && (
        <div className="loki-meta loki-meta--wrap loki-mono" style={{ overflowWrap: "anywhere" }}>
          {code.host}
        </div>
      )}
      <div style={{ fontSize: "var(--text-xs)", color: expired ? "var(--loki-negative)" : "var(--loki-muted)" }}>
        {expired ? "Expired" : `${left} left`} · type both on the other Mac's Preferences › Macs
      </div>
    </div>
  );
}

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
              <span className="loki-mono">{p.host}</span> · {p.reachable ? "connected" : `out of reach, ${lastSeen(p.last_seen_at, now)}`}
            </>
          }
        >
          {p.outdated && (
            <Chip static label title={`${osWords().Machine} and that one run different loki versions: nothing syncs until both are updated`}>
              Needs an update
            </Chip>
          )}
          <Button size="sm" tone="negative" onClick={() => onForget(p.mac_id)} title="Both Macs forget each other; pair again to reconnect">
            Forget
          </Button>
        </Setting>
      ))}
    </>
  );
}
