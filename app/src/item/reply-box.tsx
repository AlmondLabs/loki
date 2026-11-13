import { useState, type ChangeEvent, type KeyboardEvent, type ReactNode, type SyntheticEvent } from "react";
import { SendIcon } from "lucide-react";
import { Button } from "@/ui/button";
import { Kbd } from "@/ui/kbd";
import { InputGroup, InputGroupTextarea } from "@/ui/input-group";
import { PromptInputFooter, PromptInputSubmit, PromptInputTools } from "@/ui/ai-elements/prompt-input";
import { sentence } from "../components";
import { useLook } from "../theme";

/** The reply box's field as the outside card wires it: its text, its mentions and the deck's keys. */
export interface ReplyField {
  ref: (el: HTMLTextAreaElement | null) => void;
  value: string;
  disabled: boolean;
  placeholder: string;
  "aria-label": string;
  onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  onSelect: (e: SyntheticEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onFocus: () => void;
  onBlur: () => void;
}

/**
 * An outside card's reply box drawn as the new pane's Composer (plan 097, U7): the target on top (a mail's recipients
 * line, else where the reply goes: "reply in the thread", "comment on the ticket"), the field with its mention list,
 * a mail's signature and the quoted mail behind •••, then send with its key, and discard for a mail. The behaviour is
 * the card's own (outside-card.tsx OutsideReply): what is sent and how, the deck's ⌘], ⌘[ and ⌘E that send with their
 * move, who a mail goes to. The card's moves sit under it, as today. Under Liquid Glass its words follow Apple's
 * (title case on controls, sentences elsewhere) and send's key is in its tooltip, not on the box's face.
 */
export function ItemReplyBox({
  isMail,
  target,
  mentions,
  field,
  signature,
  quote,
  send,
  discard,
  error,
  actions,
}: {
  isMail: boolean;
  target: ReactNode;
  mentions: ReactNode;
  field: ReplyField;
  signature: { text: string; toggle: () => void } | null;
  quote: { text: string; forward: boolean } | null;
  send: { busy: boolean; disabled: boolean; title: string; keys: string; onSend: () => void };
  discard: { disabled: boolean; onDiscard: () => void } | null;
  error: string | null;
  actions: ReactNode;
}) {
  const glass = useLook() === "glass";
  const w = glass ? GLASS_WORDS : TODAY_WORDS;
  return (
    <div data-composer data-reply-box className="flex flex-col gap-2">
      <InputGroup className="h-auto flex-col items-stretch rounded-xl bg-card">
        <div data-target className="min-w-0 px-3 pt-2 text-meta text-muted-foreground">
          {typeof target === "string" ? w.line(target) : target}
        </div>
        <div className="relative flex flex-col">
          {mentions}
          <InputGroupTextarea
            rows={isMail ? 4 : 2}
            className="max-h-48 min-h-12 px-3 pt-2 text-body"
            {...field}
            placeholder={field.placeholder && w.line(field.placeholder)}
          />
        </div>
        <SignatureAndQuote signature={signature} quote={quote} disabled={field.disabled} w={w} />
        <PromptInputFooter className="px-2 pb-2">
          <PromptInputTools className="min-w-0">
            {discard && (
              <Button size="sm" variant="ghost" disabled={discard.disabled} onClick={discard.onDiscard} title={w.line("clear the reply and its recipients")}>
                {w.discard}
              </Button>
            )}
          </PromptInputTools>
          <PromptInputTools>
            {!glass && <Kbd className="text-muted-foreground">{send.keys}</Kbd>}
            <PromptInputSubmit
              type="button"
              aria-label={send.busy ? w.sending : w.send}
              title={w.sendTitle(send.title, send.keys)}
              disabled={send.disabled}
              onClick={send.onSend}
            >
              <SendIcon />
            </PromptInputSubmit>
          </PromptInputTools>
        </PromptInputFooter>
      </InputGroup>
      {error && (
        <p role="alert" className="m-0 text-meta text-destructive">
          {error}
        </p>
      )}
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** The reply box's words in one look: Liquid Glass's (title case on controls, sentences elsewhere) or today's. */
interface ReplyWords {
  /** A line of plain text, as that look writes it. */
  line: (s: string) => string;
  noSignature: string;
  removeSignature: string;
  addSignature: string;
  showQuote: string;
  discard: string;
  send: string;
  sending: string;
  /** Send's tooltip: Liquid Glass names the key there, since the box's face shows none. */
  sendTitle: (title: string, keys: string) => string;
}

const GLASS_WORDS: ReplyWords = {
  line: sentence,
  noSignature: "No signature",
  removeSignature: "Remove",
  addSignature: "Add Signature",
  showQuote: "Show the Quoted Mail",
  discard: "Discard",
  send: "Send",
  sending: "Sending…",
  sendTitle: (title, keys) => `${sentence(title)} (${keys})`,
};

const TODAY_WORDS: ReplyWords = {
  line: (s) => s,
  noSignature: "no signature",
  removeSignature: "remove",
  addSignature: "add signature",
  showQuote: "show the quoted mail",
  discard: "discard",
  send: "send",
  sending: "sending…",
  sendTitle: (title) => title,
};

/** A mail's signature with its toggle, and the quoted mail folded behind •••; nothing when there is neither. */
function SignatureAndQuote({
  signature,
  quote,
  disabled,
  w,
}: {
  signature: { text: string; toggle: () => void } | null;
  quote: { text: string; forward: boolean } | null;
  disabled?: boolean;
  w: ReplyWords;
}) {
  const [quoteOpen, setQuoteOpen] = useState(false);
  if (signature === null && quote === null) return null;
  return (
    <div className="flex flex-col gap-1 px-3 text-meta text-muted-foreground">
      {signature && (
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{signature.text ? `-- \n${signature.text}` : w.noSignature}</span>
          <Button size="xs" variant="ghost" disabled={disabled} onClick={signature.toggle}>
            {signature.text ? w.removeSignature : w.addSignature}
          </Button>
        </div>
      )}
      {quote && (
        <>
          <Button
            size="xs"
            variant="ghost"
            className="self-start"
            aria-expanded={quoteOpen}
            aria-label={w.showQuote}
            title={w.line(quote.forward ? "the mail goes under your note, with its files" : "the mail you answer goes quoted under your reply")}
            onClick={() => setQuoteOpen(!quoteOpen)}
          >
            •••
          </Button>
          {quoteOpen && <div className="border-l-2 border-border pl-3 whitespace-pre-wrap">{quote.text}</div>}
        </>
      )}
    </div>
  );
}
