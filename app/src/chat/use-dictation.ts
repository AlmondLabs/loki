import { useCallback, useEffect, useRef, useState } from "react";
import { inLan, keyboard, type Platform } from "../desk/env";
import { KEYMAP, keyFor, keysOf } from "../shell/keymap";

interface RecognitionAlternative {
  transcript: string;
}
interface RecognitionResult {
  isFinal: boolean;
  length: number;
  [i: number]: RecognitionAlternative | undefined;
}
interface RecognitionEvent {
  resultIndex: number;
  results: { length: number; [i: number]: RecognitionResult };
}
interface RecognitionErrorEvent {
  error: string;
}
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
 * still not dictate, so the system decides, not the check. The viewer's system (`keyboard`), not the host's:
 * speech is the page's browser's, and in the app the two are one.
 */
export function dictationSupported(hasRecognition: boolean, os: Platform = keyboard, phone: boolean = inLan): boolean {
  return hasRecognition && (os === "macos" || phone);
}

export function dictateTitle(os: Platform = keyboard): string {
  const b = KEYMAP.find((x) => x.id === "chat.dictate");
  return b && keysOf(b, os).length > 0 ? `dictate (${keyFor("chat.dictate", os)})` : "dictate";
}

export const DICTATION_SUPPORTED = dictationSupported(typeof window !== "undefined" && recognitionCtor() !== null);

export function useDictation({ onInterim, onFinal, lang }: { onInterim: (text: string) => void; onFinal: (text: string) => void; lang?: string }) {
  const [listening, setListening] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
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
    r.lang = lang ?? navigator.language;
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
      if (e.error === "no-speech" || e.error === "aborted") return;
      setError(
        e.error === "not-allowed" || e.error === "service-not-allowed" ? "microphone blocked — allow it in the address bar" : `dictation failed: ${e.error}`,
      );
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
