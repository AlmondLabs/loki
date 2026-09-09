import { useState } from "react";

/**
 * The window's toast: one line at a time, gone after four seconds unless a newer one replaced it.
 * `notice` shows a message; `message` is what the toast renders right now.
 */
export function useNotice(): { message: string | null; notice: (m: string) => void } {
  const [message, setMessage] = useState<string | null>(null);
  const notice = (m: string) => {
    setMessage(m);
    setTimeout(() => setMessage((cur) => (cur === m ? null : cur)), 4000);
  };
  return { message, notice };
}
