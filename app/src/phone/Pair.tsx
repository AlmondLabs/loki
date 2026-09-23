import { useEffect, useRef, useState } from "react";
import { modBase } from "../desk/env";
import { CODE_LENGTH, codeFromUrl, deviceName, normalizeCode } from "./model";
import { Button, Field } from "../components";

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
      if (r.status === 404) setError("That code has expired. Open Settings › phone on the Mac for a new one.");
      else setError(`The Mac answered ${r.status}. Try again from Settings › phone.`);
    } catch {
      setError("The Mac did not answer. Same Wi‑Fi, and is it awake?");
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
    <main className="loki-phone loki-phone-shell loki-phone-pair">
      <div className="loki-phone-pair-inner">
        <div>
          <span aria-hidden className="loki-phone-workspace">
            L
          </span>
          <h1 className="loki-phone-large-title loki-phone-pair-title">
            Pair with the Mac
          </h1>
          <p className="loki-phone-pair-lead">Open Settings › phone on the Mac and type the six characters it shows. Once is enough for this icon.</p>
        </div>
        <form
          className="loki-phone-pair-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(code);
          }}
        >
          <label htmlFor="pair-code" className="loki-phone-pair-label">
            Pairing code
            <Field
              id="pair-code"
              ref={inputRef}
              size="touch"
              className="loki-phone-pair-code"
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
            />
          </label>
          {error && (
            <p role="alert" className="loki-phone-error">
              {error}
            </p>
          )}
          <Button type="submit" size="touch" block className="loki-phone-pair-cta" disabled={busy || code.length !== CODE_LENGTH}>
            {busy ? "Pairing…" : "Pair"}
          </Button>
        </form>
        <p className="loki-phone-pair-foot">Same Wi‑Fi as the Mac (or its Tailscale address), and the Mac awake. Nothing is installed; this page is served by loki itself.</p>
      </div>
    </main>
  );
}
