import { Fragment, useEffect, useRef, useState, type RefObject } from "react";
import type { OutsideFacts, OutsideMessage } from "../../../core/frame-types.ts";
import { ItemMailThread, itemSlackRow } from "../item/outside-rows";
import { Button, Meta } from "../components";
import { scrollWithin } from "../shared/scroll-within";
import { ago } from "./catch-up-parts";
import { JiraTicket } from "./jira-ticket";
import { LinkedText, MailHtml } from "./mail-html";
import { MailThread, firstLine, senderName } from "./mail-thread";
import { NewLine, SlackThread, loadLabel } from "./slack-thread";
import type { ThreadState } from "./use-outside-thread";

export function OutsideLines({ facts, touch = false }: { facts: OutsideFacts; touch?: boolean }) {
  return (
    <div className="flex flex-col" style={{ gap: touch ? "var(--phone-space-3)" : 12 }}>
      {facts.lines.map((line, i) => (
        <p key={i} style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: touch ? "var(--phone-text-body)" : "var(--text-sm)" }}>
          {line}
        </p>
      ))}
    </div>
  );
}

function MessageRow({ m, folded }: { m: OutsideMessage; folded: boolean }) {
  const [opened, setOpened] = useState(false);
  const open = !folded || opened;
  const size = "var(--phone-text-body)";
  const who = (
    <span style={{ fontSize: size, fontWeight: 600, color: m.mine ? "var(--loki-positive)" : undefined }}>{m.mine ? "you" : senderName(m.sender)}</span>
  );
  if (!open)
    return (
      <button type="button" className="loki-mail-fold" onClick={() => setOpened(true)} aria-expanded={false}>
        {who}
        {m.at && <Meta>{ago(m.at)}</Meta>}
        <span className="loki-mail-fold-line" style={{ fontSize: size }}>
          {firstLine(m.text)}
        </span>
      </button>
    );
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-w-0 items-baseline gap-2">
        {who}
        {m.at && <Meta>{ago(m.at)}</Meta>}
      </div>
      {m.html ? (
        <MailHtml html={m.html} title={`Mail from ${senderName(m.sender)}`} images={m.inline_images} />
      ) : (
        <p style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: size }}>
          <LinkedText text={m.text} />
        </p>
      )}
    </div>
  );
}

const NO_ADDRESSES: readonly string[] = [];

export function OutsideThread({
  facts,
  state,
  touch = false,
  own = NO_ADDRESSES,
  items = false,
}: {
  facts: OutsideFacts;
  state: ThreadState;
  touch?: boolean;
  own?: readonly string[];
  items?: boolean;
}) {
  const end = useRef<HTMLDivElement>(null);
  const newest = state.kind === "read" ? (state.messages.at(-1)?.id ?? "") : "";
  useEffect(() => {
    const el = end.current;
    if (!newest || !el) return;
    const box = el.closest<HTMLElement>("[data-thread-scroll]");
    if (box) scrollWithin(box, el, "end");
    else el.scrollIntoView({ block: "end" });
  }, [newest]);
  if (facts.provider === "jira" && state.kind === "read" && state.ticket)
    return (
      <JiraTicket ticket={state.ticket} touch={touch}>
        {touch ? <ThreadList facts={facts} state={state} /> : <SlackRows facts={facts} state={state} stays items={items} />}
      </JiraTicket>
    );
  if (state.kind !== "read" || state.messages.length === 0) return <ThreadStandIn facts={facts} state={state} touch={touch} />;
  if (touch) return <ThreadList facts={facts} state={state} endRef={end} />;
  if (facts.provider === "gmail")
    return (
      <>
        {items ? (
          <ItemMailThread messages={state.messages} own={own} newest={facts.newest_message_id} {...(state.reacting ? { reacting: state.reacting } : {})} />
        ) : (
          <MailThread messages={state.messages} own={own} />
        )}
        <div ref={end} />
      </>
    );
  return <SlackRows facts={facts} state={state} items={items} />;
}

function SlackRows({
  facts,
  state,
  stays = false,
  items = false,
}: {
  facts: OutsideFacts;
  state: Extract<ThreadState, { kind: "read" }>;
  stays?: boolean;
  items?: boolean;
}) {
  return (
    <SlackThread
      messages={state.messages}
      newest={facts.newest_message_id}
      window={state.window ?? null}
      controls={state.controls ?? null}
      jira={facts.provider === "jira"}
      stays={stays}
      {...(items ? { row: itemSlackRow(facts.provider) } : {})}
    />
  );
}

function ThreadStandIn({ facts, state, touch }: { facts: OutsideFacts; state: ThreadState; touch: boolean }) {
  const failed = state.kind === "failed" ? state.message : null;
  const said = failed !== null && !!facts.disconnected;
  return (
    <div className="flex flex-col" style={{ gap: touch ? "var(--phone-space-3)" : 12 }}>
      {!said && (
        <Meta wrap negative={failed !== null}>
          {failed !== null ? `Could not read the whole thread: ${failed}` : "Reading the whole thread…"}
        </Meta>
      )}
      <OutsideLines facts={facts} touch={touch} />
    </div>
  );
}

function ThreadList({
  facts,
  state,
  endRef,
}: {
  facts: OutsideFacts;
  state: Extract<ThreadState, { kind: "read" }>;
  endRef?: RefObject<HTMLDivElement | null>;
}) {
  const jira = facts.provider === "jira";
  const newAt = jira ? state.messages.findIndex((m) => m.unread === true) : -1;
  const { window: w, controls } = state;
  const earlier = jira && w && controls && w.more_before !== false && w.more_before !== 0 ? controls : null;
  const earlierLabel = earlier ? loadLabel("before", true, earlier.busy === "before") : "";
  return (
    <div className="flex flex-col" style={{ gap: "var(--phone-space-4)" }}>
      {earlier && (
        <Button size="touch" bare disabled={earlier.busy !== null} onClick={() => earlier.load("before")} className="self-center">
          {`${earlierLabel[0].toUpperCase()}${earlierLabel.slice(1)}`}
        </Button>
      )}
      {state.messages.map((m, i) => (
        <Fragment key={m.id}>
          {i === newAt && <NewLine />}
          <MessageRow m={m} folded={facts.provider === "gmail" && i < state.messages.length - 1} />
        </Fragment>
      ))}
      {endRef && <div ref={endRef} />}
    </div>
  );
}
