import { useEffect, type ReactNode } from "react";
import type { Runtime } from "../../../core/attention/protocol.ts";
import type { PendingApproval, PendingQuestion } from "../../../core/attention/model.ts";
import type { ImageAttachment } from "../../../core/attention/content.ts";
import type { TranscriptRow } from "../chat/Transcript";
import { Conversation, type ChatStatus } from "../chat/Conversation";
import { AgentChip, AgentFace } from "../desk/AgentChip";
import { avatarUrl } from "../desk/env";
import { Pin } from "./Home";
import { Button, IconButton } from "../components";
import { BackButton, SAFE, TopBar } from "./ui";

/** The conversation a card opened; kept apart from the item so the screen survives the card clearing. */
export interface Thread {
  agentId: string;
  conversationId: string;
  title: string | null;
  agentName: string | null;
}

export interface ThreadView {
  rows: TranscriptRow[] | undefined;
  status: ChatStatus;
  pending: PendingApproval | null;
  question: PendingQuestion | null;
  error: string | null;
}

/**
 * One conversation, full screen: the phone's bar on top, then the same Conversation the desk and the
 * inbox card show, touch-sized, its thread and box padded past the notch and the home indicator.
 */
export function ConversationScreen({
  thread,
  view,
  waiting,
  banner,
  backLabel = "inbox",
  prefill = null,
  pinned = null,
  onPin,
  onBack,
  onLoad,
  onDecide,
  onAnswer,
  onSend,
  onSeen,
}: {
  thread: Thread;
  view: ThreadView;
  /** The card is still actionable: offer "seen" in the bar. */
  waiting: boolean;
  banner?: ReactNode;
  /** Where back goes, as a word. */
  backLabel?: string;
  /** Text the host wants in the reply box (an "ask the agent to…" from the agent's page); a new tick replaces the draft, as the desktop chat does. */
  prefill?: { text: string; tick: number } | null;
  /** The desk's pin state, when the mod knows this conversation as a desk; null hides the glyph. */
  pinned?: boolean | null;
  onPin?: (pinned: boolean) => void;
  onBack: () => void;
  onLoad: (rt: Runtime) => void;
  onDecide: (rt: Runtime, requestId: string, behavior: "allow" | "deny") => void;
  onAnswer: (rt: Runtime, requestId: string, answers: Record<string, string | string[]>) => void;
  onSend: (rt: Runtime, text: string, images: ImageAttachment[], desk: string | null) => void;
  onSeen: (rt: Runtime) => void;
}) {
  const rt: Runtime = { agent_id: thread.agentId, conversation_id: thread.conversationId };

  useEffect(() => {
    onLoad(rt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.agentId, thread.conversationId]);

  return (
    <>
      <ThreadBar thread={thread} view={view} waiting={waiting} backLabel={backLabel} pinned={pinned} onPin={onPin} onBack={onBack} onSeen={() => onSeen(rt)} />
      {banner}
      {/* The phone's column is the reading measure (PhoneStyles lifts the desktop's bubble cap under this class). */}
      <div className="loki-phone-thread" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--loki-panel)" }}>
        <Conversation
          touch
          dim={false}
          gutter={{ left: SAFE.left, right: SAFE.right, bottom: SAFE.bottom }}
          view={{ rows: view.rows, status: view.status, error: view.error, approval: view.pending, question: view.question }}
          actions={{
            onSend: (text, images = []) => onSend(rt, text, images, thread.title),
            onAnswer: view.question ? (answers) => onAnswer(rt, view.question!.requestId, answers) : undefined,
            onApprove: view.pending ? (behavior) => onDecide(rt, view.pending!.requestId, behavior) : undefined,
          }}
          agentName={thread.agentName}
          prefill={prefill}
        />
      </div>
    </>
  );
}

/** The top bar: back, the title over the agent's face and name (and "thinking…" / "writing…"), then seen and the pin on the right. */
function ThreadBar({ thread, view, waiting, backLabel, pinned, onPin, onBack, onSeen }: { thread: Thread; view: ThreadView; waiting: boolean; backLabel: string; pinned: boolean | null; onPin?: (pinned: boolean) => void; onBack: () => void; onSeen: () => void }) {
  return (
    <TopBar
      left={<BackButton onClick={onBack} label={backLabel} />}
      title={thread.title ?? thread.conversationId}
      sub={
        <>
          <AgentFace name={thread.agentName} src={avatarUrl(thread.agentId)} size={14} />
          <AgentChip name={thread.agentName} size={9.5} />
          {view.status === "thinking" && <span>thinking…</span>}
          {view.status === "streaming" && <span>writing…</span>}
        </>
      }
      right={
        <>
          {waiting && !view.pending && (
            <Button size="touch" tone="paper" onClick={onSeen}>
              seen
            </Button>
          )}
          {pinned !== null && onPin && (
            <IconButton label={pinned ? "unpin" : "pin"} size={40} onClick={() => onPin(!pinned)} aria-pressed={pinned} title={pinned ? "unpin" : "pin to the top"}>
              <Pin filled={pinned} />
            </IconButton>
          )}
        </>
      }
    />
  );
}
