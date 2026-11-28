import { DEFAULT_GOALS_SETTINGS, type GoalAutonomy } from "../../../core/goals.ts";
import { Button, Meta, Switch } from "../components";
import type { GoalsModel } from "../shell/use-goals";
import { Block, PopUp, Segmented, Setting } from "./layout";

const HOURS = Array.from({ length: 24 }, (_, i) => String(i));
const HOUR_LABELS: Record<string, string> = Object.fromEntries(HOURS.map((h) => [h, `${h.padStart(2, "0")}:00`]));
const WEEKDAYS = ["0", "1", "2", "3", "4", "5", "6"] as const;
const WEEKDAY_LABELS: Record<string, string> = {
  "0": "Sunday",
  "1": "Monday",
  "2": "Tuesday",
  "3": "Wednesday",
  "4": "Thursday",
  "5": "Friday",
  "6": "Saturday",
};

export function GoalsSettings({ goals, agents }: { goals: GoalsModel; agents: ReadonlyArray<{ id: string; name: string }> }) {
  const settings = goals.snap?.settings ?? DEFAULT_GOALS_SETTINGS;
  const pulse = goals.snap?.pulse;

  const agentOptions = ["", ...agents.map((a) => a.id)];
  const agentLabels: Record<string, string> = { "": "First available agent" };
  for (const a of agents) agentLabels[a.id] = a.name;

  return (
    <>
      <Block
        title="Proactive goal partner"
        help="Goal Pulse checks active goals in the background, preps concrete next steps, and surfaces calm daily focus and weekly reviews in Flow."
      >
        <Setting label="Proactive check-ins" help="Enable scheduled daily focus nudges, stalled-goal check-ins, and weekly reviews.">
          <Switch on={settings.enabled} onToggle={() => void goals.setSettings({ enabled: !settings.enabled })} label="Proactive check-ins" hideLabel />
        </Setting>
        <Setting label="Default partner agent" help="Leads daily focus and weekly reviews when a goal has no specific owner agent.">
          <PopUp
            label="Default partner agent"
            options={agentOptions}
            value={settings.partner_agent_id ?? ""}
            onPick={(v) => void goals.setSettings({ partner_agent_id: v || null })}
            labels={agentLabels}
          />
        </Setting>
        <Setting label="Autonomy" help="Prep and nudge gathers context and drafts suggestions or replies before nudging; Nudge only asks for the next step.">
          <Segmented<GoalAutonomy>
            label="Autonomy"
            options={["prep_and_nudge", "nudge_only"]}
            value={settings.autonomy}
            onPick={(autonomy) => void goals.setSettings({ autonomy })}
            labels={{ prep_and_nudge: "Prep and nudge", nudge_only: "Nudge only" }}
          />
        </Setting>
      </Block>

      <Block title="Cadence and quiet hours" help="Automatic check-ins pause during quiet hours and never repeat if an earlier nudge is still unanswered.">
        <Setting label="Daily focus time">
          <PopUp
            label="Daily focus time"
            options={HOURS}
            value={String(settings.daily_hour)}
            onPick={(v) => void goals.setSettings({ daily_hour: Number(v) })}
            labels={HOUR_LABELS}
          />
        </Setting>
        <Setting label="Weekly review day">
          <PopUp
            label="Weekly review day"
            options={WEEKDAYS}
            value={String(settings.weekly_day)}
            onPick={(v) => void goals.setSettings({ weekly_day: Number(v) })}
            labels={WEEKDAY_LABELS}
          />
        </Setting>
        <Setting label="Quiet hours start">
          <PopUp
            label="Quiet hours start"
            options={HOURS}
            value={String(settings.quiet_start)}
            onPick={(v) => void goals.setSettings({ quiet_start: Number(v) })}
            labels={HOUR_LABELS}
          />
        </Setting>
        <Setting label="Quiet hours end">
          <PopUp
            label="Quiet hours end"
            options={HOURS}
            value={String(settings.quiet_end)}
            onPick={(v) => void goals.setSettings({ quiet_end: Number(v) })}
            labels={HOUR_LABELS}
          />
        </Setting>
      </Block>

      <Block title="Run now">
        <Setting label="Goal check-in" help={pulse?.last_note ? `Last run: ${pulse.last_note}` : "Send a daily focus check-in or weekly review to Flow now."}>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void goals.runPulse({ kind: "daily" })} disabled={goals.running}>
              Run Daily Check-In
            </Button>
            <Button size="sm" onClick={() => void goals.runPulse({ kind: "weekly" })} disabled={goals.running}>
              Run Weekly Review
            </Button>
          </div>
        </Setting>
      </Block>

      {goals.error && (
        <Meta negative wrap>
          {goals.error}
        </Meta>
      )}
    </>
  );
}
