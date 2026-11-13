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
  const [quoteOpen, setQuoteOpen] = useState(false);
  const glass = useLook() === "glass";
  /** A line of text: a sentence under Liquid Glass, as written otherwise. */
  const line = (s: string) => (glass ? sentence(s) : s);
  return (
    <div data-composer data-reply-box className="flex flex-col gap-2">
      <InputGroup className="h-auto flex-col items-stretch rounded-xl bg-card">
        <div data-target className="min-w-0 px-3 pt-2 text-meta text-muted-foreground">
          {typeof target === "string" ? line(target) : target}
        </div>
        <div className="relative flex flex-col">
          {mentions}
          <InputGroupTextarea
            rows={isMail ? 4 : 2}
            className="max-h-48 min-h-12 px-3 pt-2 text-body"
            {...field}
            placeholder={field.placeholder && line(field.placeholder)}
          />
        </div>
        {(signature !== null || quote !== null) && (
          <div className="flex flex-col gap-1 px-3 text-meta text-muted-foreground">
            {signature && (
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="min-w-0 flex-1 whitespace-pre-wrap">{signature.text ? `-- \n${signature.text}` : line("no signature")}</span>
                <Button size="xs" variant="ghost" disabled={field.disabled} onClick={signature.toggle}>
                  {glass ? (signature.text ? "Remove" : "Add Signature") : signature.text ? "remove" : "add signature"}
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
                  aria-label={glass ? "Show the Quoted Mail" : "show the quoted mail"}
                  title={line(quote.forward ? "the mail goes under your note, with its files" : "the mail you answer goes quoted under your reply")}
                  onClick={() => setQuoteOpen(!quoteOpen)}
                >
                  •••
                </Button>
                {quoteOpen && <div className="border-l-2 border-border pl-3 whitespace-pre-wrap">{quote.text}</div>}
              </>
            )}
          </div>
        )}
        <PromptInputFooter className="px-2 pb-2">
          <PromptInputTools className="min-w-0">
            {discard && (
              <Button size="sm" variant="ghost" disabled={discard.disabled} onClick={discard.onDiscard} title={line("clear the reply and its recipients")}>
                {glass ? "Discard" : "discard"}
              </Button>
            )}
          </PromptInputTools>
          <PromptInputTools>
            {!glass && <Kbd className="text-muted-foreground">{send.keys}</Kbd>}
            <PromptInputSubmit
              type="button"
              aria-label={glass ? (send.busy ? "Sending…" : "Send") : send.busy ? "sending…" : "send"}
              title={glass ? `${sentence(send.title)} (${send.keys})` : send.title}
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
