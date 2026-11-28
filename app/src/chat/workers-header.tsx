import { useContext } from "react";
import { BotIcon, CheckIcon, CircleAlertIcon, LoaderCircleIcon, SquareIcon, type LucideIcon } from "lucide-react";
import { subagentDisplayName, type SubagentStatus, type SubagentView } from "../../../core/subagents.ts";
import { Chip, type TabStatus } from "../components";
import { OpenWorker } from "./transcript";

type StripState = "idle" | "working" | "failed";

const STATUS_ICONS: Record<SubagentStatus, LucideIcon> = {
  running: LoaderCircleIcon,
  error: CircleAlertIcon,
  done: CheckIcon,
  stopped: SquareIcon,
};

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

export function WorkersHeader({
  subagents,
  activeChat,
  touch,
}: {
  subagents: readonly SubagentView[] | null | undefined;
  activeChat?: string | null;
  touch?: boolean;
}) {
  const open = useContext(OpenWorker);
  if (activeChat && subagents && subagents.length > 1) {
    return (
      <span className="loki-workers-strip loki-workers-strip--switcher" role="group" aria-label="Workers">
        {subagents.map((w) => {
          const Icon = STATUS_ICONS[w.status];
          const label = w.name || subagentDisplayName(w.id);
          const state: StripState = w.status === "running" ? "working" : w.status === "error" ? "failed" : "idle";
          const active = w.chat_id === activeChat;
          return (
            <Chip
              key={w.chat_id}
              touch={touch}
              aria-pressed={active}
              onClick={open ? () => open(w.chat_id) : undefined}
              title={w.description || label}
              aria-label={w.description ? `${label}: ${w.description}` : label}
              data-state={state}
            >
              <span className="loki-workers-mark" data-state={state}>
                <Icon size={12} className={w.status === "running" ? "loki-icon animate-spin" : "loki-icon"} aria-hidden />
              </span>
              <span className="truncate">{label}</span>
            </Chip>
          );
        })}
      </span>
    );
  }
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
