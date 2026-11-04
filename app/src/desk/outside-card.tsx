import type { AccountDisconnectCause, AccountProvider, OutsideFacts } from "../../../core/frame-types.ts";
import type { ReactNode } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { Button, Chip, Meta, Title } from "../components";
import { ago, deckKey } from "./catch-up-parts";

/**
 * An outside card (plan 067, U3): a Gmail or Slack thread in the Inbox, not a chat. It shows who wrote, about what,
 * which account and agent it belongs to (R10), and the thread's last messages as plain text; it is never a
 * Conversation, since there is no chat to type into until it is handed off. The phone's card body is `OutsideLines`.
 */

const SERVICE: Record<AccountProvider, string> = { gmail: "Gmail", slack: "Slack" };

/** What a disconnected account's cards say (R22): what happened and how to reconnect, lowercase as desktop meta. */
export function disconnectedText(cause: AccountDisconnectCause, provider: AccountProvider): string {
  const service = SERVICE[provider];
  const where = "Preferences › Inbox accounts";
  switch (cause) {
    case "sign_in_again":
      return `${service} wants a new sign-in: ${where}`;
    case "admin_blocks":
      return `a workspace admin blocks loki in ${service}: ask them, then connect again in ${where}`;
    case "slack_signed_out":
      return `the Slack app signed out: sign in there, then connect again in ${where}`;
    case "temporarily_failing":
      return `${service} keeps failing for now: loki tries again on its own`;
  }
}

/** The account and its owner, as the card names them: "ada@acme.com · Gmail · Work". */
export function outsideWho(o: OutsideFacts): string {
  return [o.account_label, SERVICE[o.provider], o.owner_name ?? "its agent"].join(" · ");
}

/** The thread's last messages, one paragraph each, as plain text; the phone draws the same inside its card. */
export function OutsideLines({ facts, touch = false }: { facts: OutsideFacts; touch?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: touch ? "var(--phone-space-3)" : 12 }}>
      {facts.lines.map((line, i) => (
        <p key={i} style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: touch ? "var(--phone-text-body)" : 13.5 }}>
          {line}
        </p>
      ))}
    </div>
  );
}

/**
 * What a follow-up card says of the chat its thread went to before (R19): that chat's title when the list has it, else
 * that it went to a chat; null for a thread never handed off.
 */
export function wentTo(o: OutsideFacts, items: readonly AttentionItem[]): string | null {
  if (!o.handoff_conversation_id) return null;
  const chat = items.find((i) => !i.outside && i.agent_id === o.owner_agent_id && i.id === o.handoff_conversation_id);
  return chat?.title ? `went to ${chat.title}` : "went to a chat before";
}

/**
 * The desktop card for an outside thread: the header (sender, subject, account and owner, and the badge's flash), the
 * thread's last lines, and the deck's moves. Archive here archives the thread in its account; Next sets it aside;
 * hand off opens `picker`, where the thread goes to its account's agent (U8), and is off while the account is
 * disconnected.
 */
export function OutsideCard({
  current,
  facts,
  flash,
  cameBack,
  typing,
  next,
  archive,
  went = null,
  onHandoff,
  picker = null,
}: {
  current: AttentionItem;
  facts: OutsideFacts;
  flash: string | null;
  cameBack: boolean;
  typing: boolean;
  next: () => void;
  archive: () => void;
  /** The chat the thread went to before, in words (`wentTo`). */
  went?: string | null;
  /** Open the hand-off picker; absent, the card has no hand off. */
  onHandoff?: () => void;
  /** The hand-off picker while it is open. */
  picker?: ReactNode;
}) {
  const badge = current.unread ? "new" : "";
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          padding: "14px 18px",
          borderBottom: "1px solid var(--loki-border)",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <Title style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{facts.subject || "no subject"}</Title>
          <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 10, minWidth: 0, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>{facts.sender}</span>
            <Meta>{outsideWho(facts)}</Meta>
            <Meta>{ago(facts.newest_at)}</Meta>
            {went && <Meta>{went}</Meta>}
            {cameBack && <Meta>back · new since you moved on</Meta>}
          </div>
        </div>
        {(flash ?? badge) && <Chip tone="var(--loki-positive)">{flash ?? badge}</Chip>}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "16px 18px" }}>
        {facts.disconnected && (
          <Meta negative wrap style={{ display: "block", marginBottom: 12 }}>
            {disconnectedText(facts.disconnected, facts.provider)}
          </Meta>
        )}
        <OutsideLines facts={facts} />
      </div>
      {picker && <div style={{ padding: "10px 18px", borderTop: "1px solid var(--loki-border)" }}>{picker}</div>}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 18px", borderTop: "1px solid var(--loki-border)" }}>
        {onHandoff && (
          <Button
            size="sm"
            tone="positive"
            onClick={onHandoff}
            disabled={!!facts.disconnected || !!picker}
            title={
              facts.disconnected
                ? `cannot hand off now: ${disconnectedText(facts.disconnected, facts.provider)}`
                : `give the whole thread to ${facts.owner_name ?? "its agent"} in one of its chats; the card leaves until someone writes again`
            }
          >
            hand off
          </Button>
        )}
        <Button
          size="sm"
          onClick={archive}
          title={`done with this thread: it leaves the Inbox and is ${facts.provider === "gmail" ? "archived in Gmail" : "marked read in Slack"}`}
          kbd={deckKey("inbox.archive", typing)}
        >
          archive
        </Button>
        <span style={{ flex: 1 }} />
        <Button size="sm" tone="paper" onClick={next} title="set it aside: the thread stays for your next visit" kbd={deckKey("inbox.next", typing)}>
          next →
        </Button>
      </div>
    </div>
  );
}
