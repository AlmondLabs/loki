import { useContext } from "react";
import { CircleAlertIcon, LightbulbIcon, LoaderCircleIcon, type LucideIcon } from "lucide-react";
import type { AdvisorView } from "../../../core/advisor.ts";
import { Chip } from "../components";
import { Glyph } from "../shared/icons";
import { shortModel } from "./model-picker";
import { OpenAdvisor } from "./transcript";

type StripState = "idle" | "working" | "failed";

const ICON: Record<StripState, LucideIcon> = { idle: LightbulbIcon, working: LoaderCircleIcon, failed: CircleAlertIcon };

function stripOf(a: AdvisorView): { state: StripState; text: string; label: string } {
  if (a.working) {
    const text = a.waiting > 0 ? `Advisor is answering · ${String(a.waiting)} waiting` : "Advisor is answering";
    return { state: "working", text, label: `${text}: open the advisor chat` };
  }
  if (a.last_failure) return { state: "failed", text: "Advisor couldn't answer", label: `Advisor couldn't answer: ${a.last_failure}. Open the advisor chat` };
  const text = a.model ? `Advisor · ${shortModel(a.model)}` : "Advisor";
  return { state: "idle", text, label: `${text}: open the advisor chat` };
}

export function AdvisorHeader({ advisor, touch = false }: { advisor: AdvisorView | null | undefined; touch?: boolean }) {
  const open = useContext(OpenAdvisor);
  if (!advisor) return null;
  const { state, text, label } = stripOf(advisor);
  const face = (
    <>
      <Glyph icon={ICON[state]} inline />
      {text}
    </>
  );
  return (
    <span className="loki-advisor-strip" data-state={state}>
      {open ? (
        <Chip touch={touch} aria-label={label} title={label} onClick={() => open(advisor.advisor_chat)}>
          {face}
        </Chip>
      ) : (
        <Chip static touch={touch} title={label}>
          {face}
        </Chip>
      )}
    </span>
  );
}
