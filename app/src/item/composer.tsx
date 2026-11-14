import { forwardRef, type ReactNode } from "react";
import { ArrowUpIcon, FileIcon, MicIcon, PlusIcon, SquareIcon, XIcon } from "lucide-react";
import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import { isFileAttachment } from "../../../core/attention/content.ts";
import { InputGroup, InputGroupTextarea } from "@/ui/input-group";
import { PromptInputButton } from "@/ui/ai-elements/prompt-input";
import { Queue, QueueItem, QueueItemAction, QueueItemActions, QueueItemContent, QueueItemIndicator, QueueList } from "@/ui/ai-elements/queue";
import { useMessageBox, type MessageBoxProps } from "../chat/chat-input";
import { dictateTitle } from "../chat/use-dictation";
import { fileSize } from "../chat/attachments";
import { sentence } from "../components";

/** What the Composer adds to a message box: the messages queued while the agent works, and the way to take one back. */
export interface ComposerProps extends MessageBoxProps {
  queued?: readonly TranscriptRow[];
  onCancelQueued?: (text: string) => void;
  /** Above the box, at its trailing edge: what shows only now and then (the suggestions chip). */
  extras?: ReactNode;
}

/**
 * The chat's message box (plan 097, Composer): the same behaviour as the phone's ChatInput (useMessageBox: dictation,
 * files, paste and drop, Enter to send, ⌘D, the grow to six lines), drawn with AI Elements' PromptInput parts without
 * its form, whose own submit and attachments would fight loki's (KTD5). It is drawn as Messages draws its box (plan
 * 2026-11-12-1505, U21): above it the Queue, what was sent mid-turn, each with Take Back; then "+" outside a one-line
 * capsule that grows with the text; inside it, at the trailing edge, the microphone while the box is empty and the
 * accent up-arrow once there is something to send, which becomes stop while the agent works and nothing is typed. "+"
 * attaches files; the model and the permission mode are ⌘K's (⌘⇧M, ⌘⇧P), their one home, since they change rarely.
 */
export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(props, ref) {
  const box = useMessageBox(props, ref);
  return <MessagesBox {...props} box={box} />;
});

/** The box as Messages draws it: the queue, then "+" beside a capsule holding what is attached, the text, and one button. */
function MessagesBox({
  box,
  queued = [],
  onCancelQueued,
  onFocus,
  onBlur,
  onImages,
  disabled,
  canSend,
  sendLabel,
  sendTitle,
  onStop,
  stopping = false,
  extras,
  ...props
}: ComposerProps & { box: ReturnType<typeof useMessageBox> }) {
  const { uploading, picker, dictation, listening, interim, startDictation, send, field, onPicked } = box;
  const stop = onStop && !canSend;
  return (
    <div data-composer="messages" className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-6 pb-3">
      {extras && <div className="flex justify-end">{extras}</div>}
      <QueuedList queued={queued} onCancelQueued={onCancelQueued} />
      <div className="flex items-end gap-2">
        {onImages && (
          <button
            type="button"
            className="loki-composer-plus"
            aria-label="Attach Files"
            title="Attach Files"
            disabled={disabled}
            onClick={() => picker.current?.click()}
          >
            <PlusIcon aria-hidden />
          </button>
        )}
        <InputGroup data-listening={listening || undefined} className="loki-composer-capsule h-auto min-w-0 flex-1 flex-col items-stretch bg-card">
          <Attachments box={box} />
          <div className="flex items-end">
            <InputGroupTextarea
              rows={1}
              name="message"
              // iCloud Passwords skips a textarea that calls itself a search field; `type` is inert on a textarea.
              {...({ type: "search" } as object)}
              autoComplete="off"
              autoCorrect="on"
              spellCheck
              data-1p-ignore
              data-lpignore="true"
              data-bwignore
              data-form-type="other"
              disabled={disabled}
              onFocus={onFocus}
              onBlur={onBlur}
              aria-controls={props["aria-controls"]}
              aria-activedescendant={props["aria-activedescendant"]}
              aria-expanded={props["aria-expanded"]}
              className="loki-composer-field max-h-36 min-w-0 flex-1 text-body"
              {...field}
            />
            <span className="loki-composer-act">
              {stop ? (
                <button
                  type="button"
                  className="loki-composer-round"
                  data-kind="stop"
                  aria-label={stopping ? "Stopping" : "Stop"}
                  title={stopping ? "Stopping…" : "Stop the Agent's Turn"}
                  disabled={stopping}
                  onClick={onStop}
                >
                  <SquareIcon aria-hidden />
                </button>
              ) : canSend ? (
                <button
                  type="button"
                  className="loki-composer-round"
                  data-kind="send"
                  aria-label={uploading ? "Uploading…" : sendLabel}
                  title={sendTitle ? sentence(sendTitle) : sendLabel}
                  disabled={disabled || uploading}
                  onClick={send}
                >
                  <ArrowUpIcon aria-hidden />
                </button>
              ) : (
                dictation.supported && (
                  <button
                    type="button"
                    className="loki-composer-round"
                    data-kind="dictate"
                    aria-label={listening ? "Stop Dictating" : "Dictate"}
                    aria-pressed={listening}
                    title={listening ? "Stop Dictating" : sentence(dictateTitle())}
                    disabled={disabled}
                    onClick={startDictation}
                  >
                    <MicIcon aria-hidden />
                  </button>
                )
              )}
            </span>
          </div>
        </InputGroup>
      </div>
      {onImages && <input ref={picker} type="file" multiple hidden onChange={onPicked} />}
      {dictation.error && (
        <span id="loki-dictation-error" role="status" className="text-meta text-destructive">
          {dictation.error}
        </span>
      )}
      {interim && (
        <span className="sr-only" aria-live="polite">
          {interim}
        </span>
      )}
    </div>
  );
}

/** What was sent mid-turn and waits for the turn to end, each with take back; nothing while none waits. */
function QueuedList({ queued, onCancelQueued }: { queued: readonly TranscriptRow[]; onCancelQueued?: (text: string) => void }) {
  if (queued.length === 0) return null;
  return (
    <Queue aria-label="Queued messages" className="rounded-lg border bg-card px-1 py-1">
      <QueueList>
        {queued.map((row, k) => (
          <QueueItem key={`${k}-${row.text}`} className="flex-row items-center gap-2">
            <QueueItemIndicator />
            <QueueItemContent>{row.text}</QueueItemContent>
            <span className="shrink-0 text-meta text-muted-foreground">Sends when this turn ends</span>
            {onCancelQueued && (
              <QueueItemActions>
                <QueueItemAction
                  aria-label={`Take back "${row.text}"`}
                  title="Take Back"
                  className="opacity-40 focus-visible:opacity-100"
                  onClick={() => onCancelQueued(row.text)}
                >
                  <XIcon />
                </QueueItemAction>
              </QueueItemActions>
            )}
          </QueueItem>
        ))}
      </QueueList>
    </Queue>
  );
}

/** The box's images and files, the uploads still going or failed, and why the last one failed; nothing while none. */
function Attachments({ box }: { box: ReturnType<typeof useMessageBox> }) {
  const { images, uploads, failedUpload, remove } = box;
  return (
    <>
      {(images.length > 0 || uploads.length > 0) && (
        <div data-attachments className="flex flex-wrap gap-2 px-3 pt-2">
          {images.map((a) =>
            isFileAttachment(a) ? (
              <span key={a.id} title={a.path} className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-meta">
                <FileIcon className="size-4 text-muted-foreground" aria-hidden />
                <span className="loki-truncate max-w-40">{a.name}</span>
                <span className="text-muted-foreground">{fileSize(a.size)}</span>
                <PromptInputButton size="icon-xs" aria-label={`Remove ${a.name}`} onClick={() => remove(a)}>
                  <XIcon />
                </PromptInputButton>
              </span>
            ) : (
              <span key={a.id} className="relative inline-block">
                <img src={a.url} alt="" className="block h-14 max-w-30 rounded-sm border object-cover" />
                <PromptInputButton
                  size="icon-xs"
                  aria-label={"Remove Image"}
                  onClick={() => remove(a)}
                  className="absolute -top-2 -right-2 rounded-full border bg-card"
                >
                  <XIcon />
                </PromptInputButton>
              </span>
            ),
          )}
          {uploads.map((u) => (
            <span
              key={u.id}
              title={u.error}
              data-failed={u.error ? true : undefined}
              className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-meta"
            >
              <FileIcon className="size-4 text-muted-foreground" aria-hidden />
              <span className="loki-truncate max-w-40">{u.name}</span>
              <span className={u.error ? "text-destructive" : "text-muted-foreground"}>{u.error ? "Failed" : `${Math.round(u.share * 100)}%`}</span>
              {u.error && (
                <PromptInputButton size="icon-xs" aria-label={`Remove ${u.name}`} onClick={() => box.dismissUpload(u.id)}>
                  <XIcon />
                </PromptInputButton>
              )}
            </span>
          ))}
        </div>
      )}
      {failedUpload && (
        <span role="status" className="px-3 pt-2 text-meta text-destructive">
          {failedUpload.name}: {failedUpload.error}
        </span>
      )}
    </>
  );
}
