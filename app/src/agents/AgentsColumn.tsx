import { useMemo } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { IconButton, ListRow } from "../components";
import { AgentFace } from "../desk/AgentChip";
import { Icon } from "../shared/icons";
import { ColumnHeader } from "../shell/ListColumn";
import { agentDmRows } from "./rows";
import { agentsSelection, shownAgent, useAgentsSelection, type AgentsSelection } from "./selection";

/**
 * The Agents column, Slack's DMs (plan 013 U10): one row per agent — its face with the green dot while a
 * turn runs, its name, the last thing it said, and a red badge for what waits on you in the Inbox. The
 * chosen agent is current; "+" in the header opens the new-agent form in the pane. The choice is shared
 * with the pane through the selection store, so the two agree without the Shell holding it.
 */
export function AgentsColumn({ agents, desks, items, avatar, initialAgentId, selection = agentsSelection }: { agents: Array<{ id: string; name: string }>; desks: Array<{ agentId: string | null; status: string }>; items: AttentionItem[]; avatar: (agentId: string) => string; initialAgentId: string | null; selection?: AgentsSelection }) {
  const sel = useAgentsSelection(selection);
  const rows = useMemo(() => agentDmRows(agents, desks, items), [agents, desks, items]);
  const current = sel.creating ? null : shownAgent(sel.agent, initialAgentId, agents);
  return (
    <>
      <ColumnHeader
        title="Agents"
        actions={
          <IconButton label="New agent" onClick={() => selection.setCreating(true)}>
            <Icon name="plus" size={16} />
          </IconButton>
        }
      />
      <div className="loki-column-scroll">
        <ul className="loki-list" aria-label="Agents">
          {rows.map((r) => (
            <ListRow key={r.id} lead={<AgentFace name={r.name} src={avatar(r.id)} size={20} />} title={r.name} preview={r.preview} badge={r.waiting} live={r.running} current={r.id === current} onOpen={() => selection.pickAgent(r.id)} />
          ))}
        </ul>
      </div>
    </>
  );
}
