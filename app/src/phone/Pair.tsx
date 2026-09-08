import { useEffect, useRef, useState } from "react";
import { modBase } from "../desk/env";
import { CODE_LENGTH, codeFromUrl, deviceName, normalizeCode } from "./model";
import { Button, Field } from "../ui";
import { SAFE } from "./ui";

export interface Me {
  deviceId: string;
  name: string;
}

/**
 * Not paired yet. A `?code=` in the address (the QR) is redeemed at once; otherwise, or when it has
 * expired, the six letters shown in Settings › phone go in the field — a home-screen icon launches
 * from "/" with no query, so the field is always there. Six characters typed is the tap.
 */
export function Pair({ onPaired }: { onPaired: (me: Me) => void }) {
  /** The field starts with the code the QR put in the address; the mount effect below redeems it. */
  const [code, setCode] = useState(() => codeFromUrl(location.href) ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = async (c: string) => {
    if (c.length !== CODE_LENGTH || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${modBase()}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ code: c, name: deviceName(navigator.userAgent, new Date(), navigator.maxTouchPoints) }),
      });
      if (r.ok) {
        history.replaceState(null, "", location.pathname); // the code is spent; a reload must not redeem it again
        onPaired((await r.json()) as Me);
        return;
      }
      if (r.status === 404) setError("that code has expired; open Settings › phone on the Mac for a new one");
      else setError(`the Mac answered ${r.status}; try again from Settings › phone`);
    } catch {
      setError("the Mac did not answer — same Wi‑Fi, and is it awake?");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const fromUrl = codeFromUrl(location.href);
    if (fromUrl) void submit(fromUrl);
    else inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onChange = (raw: string) => {
    const next = normalizeCode(raw);
    setCode(next);
    setError(null);
    if (next.length === CODE_LENGTH) void submit(next); // auto-advance: the sixth character pairs
  };

  return (
    <main style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", justifyContent: "center", padding: `calc(24px + ${SAFE.top}) calc(24px + ${SAFE.right}) calc(24px + ${SAFE.bottom}) calc(24px + ${SAFE.left})`, background: "var(--loki-bg)", color: "var(--loki-fg)", boxSizing: "border-box" }}>
      <div style={{ maxWidth: 420, width: "100%", margin: "0 auto", display: "grid", gap: 18 }}>
        <div>
          <div className="loki-label">loki · phone</div>
          <h1 style={{ margin: "6px 0 0", fontFamily: "var(--loki-display)", fontSize: 28, fontWeight: 400, color: "var(--loki-fg)" }}>Pair with the Mac</h1>
          <p style={{ margin: "8px 0 0", fontSize: 13.5, lineHeight: 1.5, color: "var(--loki-muted)" }}>Open Settings › phone on the Mac and type the six characters it shows. Once is enough for this icon.</p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit(code);
          }}
          style={{ display: "grid", gap: 12 }}
        >
          <label htmlFor="pair-code" style={{ display: "grid", gap: 6 }}>
            <span className="loki-label" style={{ fontSize: 9.5 }}>pairing code</span>
            <Field
              id="pair-code"
              ref={inputRef}
              size="touch"
              mono
              value={code}
              onChange={(e) => onChange(e.target.value)}
              disabled={busy}
              inputMode="text"
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="one-time-code"
              spellCheck={false}
              maxLength={CODE_LENGTH}
              placeholder="ABC234"
              aria-label="six-character pairing code"
              aria-invalid={!!error}
              style={{ fontSize: 28, letterSpacing: "0.14em", textTransform: "uppercase", textAlign: "center" }}
            />
          </label>
          {error && (
            <div role="alert" style={{ fontSize: 13.5, lineHeight: 1.5, color: "var(--loki-negative)" }}>
              {error}
            </div>
          )}
          <Button type="submit" size="touch" tone="brass" disabled={busy || code.length !== CODE_LENGTH}>
            {busy ? "pairing…" : "Pair"}
          </Button>
        </form>
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--loki-muted)" }}>Same Wi‑Fi as the Mac, and the Mac awake. Nothing is installed; this page is served by loki itself.</p>
      </div>
    </main>
  );
}
