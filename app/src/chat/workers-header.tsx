import { useContext } from "react";
import { BotIcon, CircleAlertIcon, LoaderCircleIcon, type LucideIcon } from "lucide-react";
import type { SubagentView } from "../../../core/subagents.ts";
import { Chip, type TabStatus } from "../components";
import { OpenWorker } from "./transcript";

type StripState = "idle" | "working" | "failed";

function summaryOf(subagents: readonly SubagentView[]): {
  state: StripState;
  text: string;
  detail: string;
  target: string;
} | null {
  if (subagents.length === 0) return null;
  const running = subagents.filter((s) => s.status === "running");
  const errored = subagents.filter((s) => s.status === "error");
  if (running.length > 0) {
    const text = running.length === 1 ? `${running[0].name} is working` : `${running.length} workers active`;
    return { state: "working", text, detail: `${text}: open Workers`, target: running[0].chat_id };
  }
  if (errored.length > 0) {
    const first = errored[0];
    const text = errored.length === 1 ? `${first.name} failed` : `${errored.length} workers failed`;
    const detail = first.error ? `${text}: ${first.error}` : `${text}: open Workers`;
    return { state: "failed", text, detail, target: first.chat_id };
  }
  const text = subagents.length === 1 ? subagents[0].name : `${subagents.length} workers`;
  return { state: "idle", text, detail: `${text}: open Workers`, target: subagents[0].chat_id };
}

const ICONS: Record<StripState, LucideIcon> = { idle: BotIcon, working: LoaderCircleIcon, failed: CircleAlertIcon };

export function workersTabStatus(subagents: readonly SubagentView[]): TabStatus | null {
  const s = summaryOf(subagents);
  if (!s || s.state === "idle") return null;
  const Icon = ICONS[s.state];
  return {
    glyph: <Icon size={12} className={s.state === "working" ? "animate-spin" : undefined} aria-hidden />,
    words: s.text,
  };
}

export function WorkersHeader({ subagents, touch }: { subagents: readonly SubagentView[] | null | undefined; touch?: boolean }) {
  const open = useContext(OpenWorker);
  const s = subagents ? summaryOf(subagents) : null;
  if (!s) return null;
  const Icon = ICONS[s.state];
  const inside = (
    <>
      <span className="loki-workers-mark" data-state={s.state}>
        <Icon size={12} className={s.state === "working" ? "loki-icon animate-spin" : "loki-icon"} aria-hidden />
      </span>
      <span className="truncate">{s.text}</span>
    </>
  );
  return (
    <span className="loki-workers-strip" data-state={s.state}>
      <Chip touch={touch} onClick={open ? () => open(s.target) : undefined} title={s.detail} aria-label={s.detail} style={{ minWidth: 0, maxWidth: "100%" }}>
        {inside}
      </Chip>
    </span>
  );
}
