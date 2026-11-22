import { useMemo } from "react";
import { ChevronLeftIcon } from "lucide-react";
import type { AdvisorView } from "../../../core/advisor.ts";
import { useThreadRows, type useAttention } from "../../../core/attention/use-attention.ts";
import { PaneHeader } from "../components";
import { Glyph } from "../shared/icons";
import { draftKey, useDraft } from "../shared/drafts";
import { Conversation, type ConversationActions, type ConversationView } from "../chat/conversation";
import { shortModel } from "../chat/model-picker";
import { avatarUrl } from "./env";
import { useDeskChat } from "./use-desk-chat";

export function AdvisorPaneHeader({ chatName, advisor, onBack }: { chatName: string; advisor: AdvisorView | null | undefined; onBack: () => void }) {
  return (
    <PaneHeader
      title="Advisor"
      lead={
        <button type="button" className="loki-advisor-back" aria-label={`Back to ${chatName}`} title={`Back to ${chatName}`} onClick={onBack}>
          <Glyph icon={ChevronLeftIcon} />
          <span className="loki-truncate">{chatName}</span>
        </button>
      }
      aside={advisor?.model ? shortModel(advisor.model) : null}
    />
  );
}

export function AdvisorPane({
  catchUp,
  agentId,
  agentName,
  advisorChat,
  chatName,
  advisor,
  onBack,
}: {
  catchUp: ReturnType<typeof useAttention>;
  agentId: string;
  agentName: string | null;
  advisorChat: string;
  chatName: string;
  advisor: AdvisorView | null | undefined;
  onBack: () => void;
}) {
  const { deskRuntime: rt, deskChat: face } = useDeskChat({ agentId, conversationId: advisorChat, showing: true, catchUp });
  const rows = useThreadRows(catchUp, agentId, advisorChat);
  const [draftValue, setDraft] = useDraft(draftKey(agentId, advisorChat));
  const people = useMemo(
    () => ({ assistant: { name: agentName ? `${agentName}'s advisor` : "Advisor", avatar: avatarUrl(agentId) }, user: { name: "You" } }),
    [agentName, agentId],
  );
  const view: ConversationView = {
    rows,
    status: face?.status ?? "idle",
    error: face?.error ?? null,
    model: advisor?.model ?? null,
    engine: face?.engine ?? null,
    approval: face?.pending ?? null,
    question: face?.question ?? null,
    older: face?.older ?? null,
    loadFailed: face?.loadFailed ?? null,
    loadStep: face?.loadStep,
  };
  const actions: ConversationActions = {
    onSend: (text, images) => rt && catchUp.send(rt, text, images, { desk: null, labels: null, origin: "desk" }),
    onAnswer: (answers) => {
      if (rt && face?.question) catchUp.answer(rt, face.question.requestId, answers);
    },
    onApprove: (behavior) => {
      if (rt && face?.pending) catchUp.decide(rt, face.pending.requestId, behavior);
    },
    onCancelQueued: (text) => rt && catchUp.cancelQueued(rt, text),
    onStop: rt ? () => catchUp.stop(rt) : undefined,
  };
  return (
    <div className="loki-desk-pane">
      <AdvisorPaneHeader chatName={chatName} advisor={advisor} onBack={onBack} />
      <div className="loki-desk-pane-body">
        <div className="loki-desk-pane-panel loki-desk-pane-messages">
          <Conversation view={view} actions={actions} agentName={agentName} layout={{ people }} draft={{ value: draftValue, onChange: setDraft }} dim={false} />
        </div>
      </div>
    </div>
  );
}
