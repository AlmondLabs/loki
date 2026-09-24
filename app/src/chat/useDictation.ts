import { useCallback, useEffect, useRef, useState } from "react";
import { inLan, platform, type Platform } from "../desk/env";
import { KEYMAP, keyFor, keysOf } from "../shell/keymap";

/**
 * Speech to text through the browser's Web Speech API (Chrome: webkitSpeechRecognition).
 * Continuous with interim results; recognition ends on its own after a pause,
 * which is the natural end of a dictated message. Note: Chrome may send the
 * audio to Google's speech service unless on-device recognition is available.
 */
interface RecognitionAlternative { transcript: string }
interface RecognitionResult { isFinal: boolean; length: number; [i: number]: RecognitionAlternative }
interface RecognitionEvent { resultIndex: number; results: { length: number; [i: number]: RecognitionResult } }
interface RecognitionErrorEvent { error: string }
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * The mic shows on the Mac (and on a phone, whatever its user agent reads as) when the page has speech
 * recognition. Not on Windows or Linux yet (R3): WebView2 and WebKitGTK can answer the feature check and
 * still not dictate, so the system decides, not the check.
 */
export function dictationSupported(hasRecognition: boolean, os: Platform = platform, phone: boolean = inLan): boolean {
  return hasRecognition && (os === "macos" || phone);
}

/** The mic's tooltip, with ⌘D where the keymap lists it (the Mac); a phone that reads as Linux has the mic but no listed key. */
export function dictateTitle(os: Platform = platform): string {
  const b = KEYMAP.find((x) => x.id === "chat.dictate");
  return b && keysOf(b, os).length > 0 ? `dictate (${keyFor("chat.dictate", os)})` : "dictate";
}

export const DICTATION_SUPPORTED = dictationSupported(typeof window !== "undefined" && recognitionCtor() !== null);

export function useDictation({
  onInterim,
  onFinal,
  lang,
}: {
  /** Words still being recognised; replace the previous interim text with these. */
  onInterim: (text: string) => void;
  /** A finished phrase; append it. */
  onFinal: (text: string) => void;
  lang?: string;
}) {
  const [listening, setListening] = useState(false);
  /** start() was called but the browser has not begun listening yet (permission prompt, engine spin-up). */
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  // The recogniser's callbacks are wired once per start(); they read the latest handlers through this ref.
  const handlers = useRef({ onInterim, onFinal });
  useEffect(() => {
    handlers.current = { onInterim, onFinal };
  });

  const stop = useCallback(() => {
    rec.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor || rec.current) return;
    const r = new Ctor();
    r.lang = lang ?? navigator.language ?? "en-US";
    r.continuous = true;
    r.interimResults = true;
    r.onstart = () => {
      setError(null);
      setPending(false);
      setListening(true);
    };
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = res[0]?.transcript ?? "";
        if (res.isFinal) handlers.current.onFinal(text.trim());
        else interim += text;
      }
      handlers.current.onInterim(interim.trim());
    };
    r.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return; // a pause, or we stopped it
      setError(e.error === "not-allowed" || e.error === "service-not-allowed" ? "microphone blocked — allow it in the address bar" : `dictation failed: ${e.error}`);
    };
    r.onend = () => {
      rec.current = null;
      setPending(false);
      setListening(false);
      handlers.current.onInterim("");
    };
    rec.current = r;
    try {
      setPending(true);
      r.start();
    } catch {
      rec.current = null;
      setPending(false);
    }
  }, [lang]);

  const toggle = useCallback(() => {
    if (rec.current) stop();
    else start();
  }, [start, stop]);

  useEffect(() => () => rec.current?.abort(), []);

  return { supported: DICTATION_SUPPORTED, listening, pending, error, start, stop, toggle };
}
