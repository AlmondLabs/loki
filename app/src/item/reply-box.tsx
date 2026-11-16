import { useState, type ChangeEvent, type KeyboardEvent, type ReactNode, type SyntheticEvent } from "react";
import { SendIcon } from "lucide-react";
import { Button } from "@/ui/button";
import { InputGroup, InputGroupTextarea } from "@/ui/input-group";
import { PromptInputFooter, PromptInputSubmit, PromptInputTools } from "@/ui/ai-elements/prompt-input";
import { sentence } from "../components";

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
  return (
    <div data-composer data-reply-box className="flex flex-col gap-2">
      <InputGroup className="h-auto flex-col items-stretch rounded-xl bg-card">
        <div data-target className="min-w-0 px-3 pt-2 text-xs text-muted-foreground">
          {typeof target === "string" ? WORDS.line(target) : target}
        </div>
        <div className="relative flex flex-col">
          {mentions}
          <InputGroupTextarea
            rows={isMail ? 4 : 2}
            className="max-h-48 min-h-12 px-3 pt-2 text-sm"
            {...field}
            placeholder={field.placeholder && WORDS.line(field.placeholder)}
          />
        </div>
        <SignatureAndQuote signature={signature} quote={quote} disabled={field.disabled} />
        <PromptInputFooter className="px-2 pb-2">
          <PromptInputTools className="min-w-0">
            {discard && (
              <Button
                size="sm"
                variant="ghost"
                className="rounded-2xl"
                disabled={discard.disabled}
                onClick={discard.onDiscard}
                title={WORDS.line("clear the reply and its recipients")}
              >
                {WORDS.discard}
              </Button>
            )}
          </PromptInputTools>
          <PromptInputTools>
            <PromptInputSubmit
              type="button"
              className="rounded-2xl"
              aria-label={send.busy ? WORDS.sending : WORDS.send}
              title={WORDS.sendTitle(send.title, send.keys)}
              disabled={send.disabled}
              onClick={send.onSend}
            >
              <SendIcon />
            </PromptInputSubmit>
          </PromptInputTools>
        </PromptInputFooter>
      </InputGroup>
      {error && (
        <p role="alert" className="m-0 text-xs text-destructive">
          {error}
        </p>
      )}
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

interface ReplyWords {
  line: (s: string) => string;
  noSignature: string;
  removeSignature: string;
  addSignature: string;
  showQuote: string;
  discard: string;
  send: string;
  sending: string;
  sendTitle: (title: string, keys: string) => string;
}

const WORDS: ReplyWords = {
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

function SignatureAndQuote({
  signature,
  quote,
  disabled,
}: {
  signature: { text: string; toggle: () => void } | null;
  quote: { text: string; forward: boolean } | null;
  disabled?: boolean;
}) {
  const [quoteOpen, setQuoteOpen] = useState(false);
  if (signature === null && quote === null) return null;
  return (
    <div className="flex flex-col gap-1 px-3 text-xs text-muted-foreground">
      {signature && (
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{signature.text ? `-- \n${signature.text}` : WORDS.noSignature}</span>
          <Button size="xs" variant="ghost" disabled={disabled} onClick={signature.toggle}>
            {signature.text ? WORDS.removeSignature : WORDS.addSignature}
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
            aria-label={WORDS.showQuote}
            title={WORDS.line(quote.forward ? "the mail goes under your note, with its files" : "the mail you answer goes quoted under your reply")}
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
