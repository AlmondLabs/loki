import { useEffect, useEffectEvent, useState } from "react";
import type { Lane, LaneSide } from "../../../core/attention/lanes.ts";
import type { AccountProvider, AccountView } from "../../../core/frame-types.ts";
import type { MacAccountView } from "../../../core/frames.ts";
import { Button, Field } from "../components";
import type { AgentName } from "./accounts";
import { Block, Segmented, Setting } from "./layout";

/**
 * Preferences › Flow's lane editor (plan 087, U8): the lanes the person made, and one lane's name and two sides, chats
 * from all agents, picked ones or none, then mail and Slack from all accounts, picked ones or none (R9). Saving sends
 * the whole list to the mod, which shares it with every paired Mac and the phone (KTD1).
 */

/** The lanes as the mod keeps them, null until it says, and a new whole list to keep (useDesk's lanes and setLanes). */
export interface LanesApi {
  lanes: Lane[] | null;
  set: (lanes: Lane[]) => void;
}

/** The accounts a lane can pick: this Mac's and every paired Mac's (core/daemon-calls.ts accounts.everywhere, KTD9). */
export interface LaneAccountsApi {
  everywhere: () => Promise<{ accounts: AccountView[]; other_macs: MacAccountView[] } | string>;
}

/** What the lane editor needs: the lanes, the accounts to pick from, the agents by name, and how a new lane's id is made. */
export interface LanesProps {
  lanes: LanesApi;
  accounts: LaneAccountsApi;
  agents: readonly AgentName[];
  /** A new lane's id; a random one unless a test gives its own. */
  newId?: () => string;
}

/** How one side of a lane is chosen in the editor: everything, the ticked ones, or nothing. */
export type SideChoice = "all" | "pick" | "none";

/**
 * A lane as the editor holds it while the person changes it. The ticked ids stay when the side is set to all or none,
 * so going back to pick finds them as they were, and ids this Mac does not know stay too (KTD2).
 */
export interface LaneDraft {
  id: string;
  name: string;
  chats: SideChoice;
  chatIds: string[];
  accounts: SideChoice;
  accountIds: string[];
}

/** An account as the editor lists it to pick: what it is, the agent that owns it, and the Mac it lives on when not this one. */
export interface LaneAccount {
  account_id: string;
  label: string;
  service: string;
  owner: string;
  /** The paired Mac's name; null for this Mac's own accounts. */
  mac: string | null;
}

const SERVICE: Record<AccountProvider, string> = { gmail: "Gmail", slack: "Slack" };

const SIDE_CHOICES: readonly SideChoice[] = ["all", "pick", "none"];

/** How often the accounts are asked again while the page shows, as Preferences › Accounts does: one may connect meanwhile. */
const POLL_MS = 3000;

const newLaneId = () => `lane-${crypto.randomUUID()}`;

const choiceOf = (side: LaneSide): SideChoice => (side === "all" ? "all" : side.length ? "pick" : "none");
const sideOf = (choice: SideChoice, ids: string[]): LaneSide => (choice === "all" ? "all" : choice === "pick" ? ids : []);

/** A saved lane as the editor holds it: an empty list reads as none, and a list as the ticked ids. */
export function draftOf(lane: Lane): LaneDraft {
  return {
    id: lane.id,
    name: lane.name,
    chats: choiceOf(lane.chats),
    chatIds: lane.chats === "all" ? [] : [...lane.chats],
    accounts: choiceOf(lane.accounts),
    accountIds: lane.accounts === "all" ? [] : [...lane.accounts],
  };
}

/** A new lane before anything is chosen: no name, and both sides on pick with nothing ticked. */
export function newDraft(id: string): LaneDraft {
  return { id, name: "", chats: "pick", chatIds: [], accounts: "pick", accountIds: [] };
}

/**
 * The whole list to send once a draft is saved, the lane replaced where it was or added at the end; or why it cannot be
 * saved: a name must be there and no other lane may have it, case aside. A pick with nothing ticked is none.
 */
export function saveLane(lanes: readonly Lane[], draft: LaneDraft): Lane[] | string {
  const name = draft.name.trim();
  if (!name) return "a lane needs a name";
  const other = lanes.find((l) => l.id !== draft.id && l.name.trim().toLowerCase() === name.toLowerCase());
  if (other) return `another lane is called ${other.name}`;
  const lane: Lane = { id: draft.id, name, chats: sideOf(draft.chats, draft.chatIds), accounts: sideOf(draft.accounts, draft.accountIds) };
  return lanes.some((l) => l.id === draft.id) ? lanes.map((l) => (l.id === draft.id ? lane : l)) : [...lanes, lane];
}

/** The whole list to send once a lane is deleted: every other lane, as it was. */
export function withoutLane(lanes: readonly Lane[], id: string): Lane[] {
  return lanes.filter((l) => l.id !== id);
}

/** The ticked ids once one box is ticked or cleared, the rest kept in their order. */
export function ticked(ids: readonly string[], id: string, on: boolean): string[] {
  const rest = ids.filter((i) => i !== id);
  return on ? [...rest, id] : rest;
}

/** Every account a lane can pick, this Mac's first: its owner by name, and the Mac it lives on for a paired Mac's. */
export function laneAccounts(r: { accounts: readonly AccountView[]; other_macs: readonly MacAccountView[] }, agents: readonly AgentName[]): LaneAccount[] {
  const row = (a: AccountView, mac: string | null): LaneAccount => ({
    account_id: a.account_id,
    label: a.address,
    service: SERVICE[a.provider],
    owner: agents.find((g) => g.id === a.owner_agent_id)?.name ?? (mac ? `an agent on ${mac}` : "an agent no longer here"),
    mac,
  });
  return [...r.accounts.map((a) => row(a, null)), ...r.other_macs.map((a) => row(a, a.mac_name))];
}

/**
 * The accounts to pick from, asked again every few seconds while a lane is open in the editor (`open`), and not at all
 * otherwise; null until the first answer, or why not.
 */
function useLaneAccounts(api: LaneAccountsApi, agents: readonly AgentName[], open: boolean): LaneAccount[] | string | null {
  const [answer, setAnswer] = useState<{ accounts: AccountView[]; other_macs: MacAccountView[] } | string | null>(null);
  const read = useEffectEvent(() => api.everywhere());
  useEffect(() => {
    if (!open) return;
    let live = true;
    const load = () => void read().then((r) => live && setAnswer(r));
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [open]);
  return answer === null || typeof answer === "string" ? answer : laneAccounts(answer, agents);
}

/**
 * The lane list with "new lane", and the editor of the lane opened from it. Nothing is sent until save; a name that is
 * missing or taken says so in the editor and sends nothing.
 */
export function Lanes({ lanes: api, accounts, agents, newId = newLaneId }: LanesProps) {
  const [draft, setDraft] = useState<LaneDraft | null>(null);
  const choices = useLaneAccounts(accounts, agents, draft !== null);
  const [error, setError] = useState<string | null>(null);
  const { lanes, set } = api;
  if (!lanes) return <Setting label="Lanes" help="asking loki…" />;
  const open = (d: LaneDraft) => {
    setDraft(d);
    setError(null);
  };
  const save = (d: LaneDraft) => {
    const next = saveLane(lanes, d);
    if (typeof next === "string") return setError(next);
    setError(null);
    set(next);
  };
  const saved = draft !== null && lanes.some((l) => l.id === draft.id);
  return (
    <Block
      title="Lanes"
      help="a lane is the part of your work Flow shows while you are in it: chats from some agents, mail and Slack from some accounts. Switch lanes from Flow's title, on each device on its own."
    >
      <div style={{ display: "grid", gridTemplateColumns: "minmax(120px, 180px) 1fr", gap: 24, padding: "12px 0", alignItems: "start" }}>
        <div role="group" aria-label="lanes" style={{ display: "grid", gap: 4, justifyItems: "start" }}>
          {lanes.length === 0 && <span className="loki-meta loki-meta--wrap">No lanes yet</span>}
          {lanes.map((l) => (
            <Button key={l.id} size="sm" bare={draft?.id !== l.id} aria-pressed={draft?.id === l.id} onClick={() => open(draftOf(l))}>
              {l.name}
            </Button>
          ))}
          <Button size="sm" tone="positive" onClick={() => open(newDraft(newId()))}>
            new lane
          </Button>
        </div>
        {draft ? (
          <LaneEditor
            key={draft.id}
            draft={draft}
            lanes={lanes}
            agents={agents}
            accounts={choices}
            error={error}
            onDraft={open}
            onSave={() => save(draft)}
            onDelete={
              saved
                ? () => {
                    set(withoutLane(lanes, draft.id));
                    setDraft(null);
                  }
                : null
            }
          />
        ) : (
          <span className="loki-meta loki-meta--wrap">Open a lane to change it, or make a new one.</span>
        )}
      </div>
    </Block>
  );
}

/**
 * One lane's editor: its name, then its chats and its accounts, each all, pick or none, with a box for each agent or
 * account under pick. Each account names its owner agent, and its Mac when it lives on another (R9).
 */
export function LaneEditor({
  draft,
  lanes,
  agents,
  accounts,
  error,
  onDraft,
  onSave,
  onDelete,
}: {
  draft: LaneDraft;
  lanes: readonly Lane[];
  agents: readonly AgentName[];
  /** The accounts to pick from; null while loki is asked, or why they could not be read. */
  accounts: LaneAccount[] | string | null;
  /** Why the last save was refused, shown under the name. */
  error: string | null;
  onDraft: (d: LaneDraft) => void;
  onSave: () => void;
  /** Deletes the lane; null for a lane not saved yet. */
  onDelete: (() => void) | null;
}) {
  const [confirm, setConfirm] = useState(false);
  const title = lanes.find((l) => l.id === draft.id)?.name ?? "the new lane";
  return (
    <form
      aria-label={`edit ${title}`}
      style={{ display: "grid", gap: 8 }}
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <Field
        size="sm"
        name="lane-name"
        aria-label="lane name"
        placeholder="name, like work"
        autoComplete="off"
        value={draft.name}
        onChange={(e) => onDraft({ ...draft, name: e.target.value })}
      />
      {error && (
        <div role="alert" className="loki-meta loki-meta--negative loki-meta--wrap">
          {error}
        </div>
      )}
      <Setting label="Chats" help="All takes in agents added later; picked ones stay as picked.">
        <Segmented
          label={`chats in ${title}`}
          options={SIDE_CHOICES}
          value={draft.chats}
          onPick={(chats) => onDraft({ ...draft, chats })}
          labels={{ all: "all agents" }}
        />
      </Setting>
      {draft.chats === "pick" && (
        <Picks
          label={`agents in ${title}`}
          items={agents.map((g) => ({ id: g.id, label: g.name, detail: null }))}
          ids={draft.chatIds}
          onTick={(id, on) => onDraft({ ...draft, chatIds: ticked(draft.chatIds, id, on) })}
          empty="No agents yet."
        />
      )}
      <Setting label="Mail and Slack" help="All takes in accounts connected later, on every Mac.">
        <Segmented
          label={`mail and Slack in ${title}`}
          options={SIDE_CHOICES}
          value={draft.accounts}
          onPick={(side) => onDraft({ ...draft, accounts: side })}
          labels={{ all: "all accounts" }}
        />
      </Setting>
      {draft.accounts === "pick" &&
        (typeof accounts === "string" ? (
          <div className="loki-meta loki-meta--negative loki-meta--wrap">{accounts}</div>
        ) : accounts === null ? (
          <span className="loki-meta">asking loki…</span>
        ) : (
          <Picks
            label={`accounts in ${title}`}
            items={accounts.map((a) => ({ id: a.account_id, label: a.label, detail: [a.service, a.owner, a.mac].filter(Boolean).join(" · ") }))}
            ids={draft.accountIds}
            onTick={(id, on) => onDraft({ ...draft, accountIds: ticked(draft.accountIds, id, on) })}
            empty="No accounts yet: connect one in Preferences › Accounts."
          />
        ))}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Button size="sm" tone="positive" type="submit">
          save
        </Button>
        {onDelete &&
          (confirm ? (
            <>
              <Button size="sm" tone="negative" onClick={onDelete}>
                delete {title}
              </Button>
              <Button size="sm" onClick={() => setConfirm(false)}>
                keep it
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => setConfirm(true)}>
              delete
            </Button>
          ))}
      </div>
    </form>
  );
}

/** A box for each agent or account under pick, ticked when its id is picked. */
function Picks({
  label,
  items,
  ids,
  onTick,
  empty,
}: {
  label: string;
  items: Array<{ id: string; label: string; detail: string | null }>;
  ids: readonly string[];
  onTick: (id: string, on: boolean) => void;
  empty: string;
}) {
  if (!items.length) return <span className="loki-meta loki-meta--wrap">{empty}</span>;
  return (
    <div role="group" aria-label={label} style={{ display: "grid", gap: 4 }}>
      {items.map((i) => (
        <label key={i.id} style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 8, alignItems: "baseline", cursor: "pointer" }}>
          <input type="checkbox" checked={ids.includes(i.id)} onChange={(e) => onTick(i.id, e.target.checked)} aria-label={`pick ${i.label}`} />
          <span style={{ minWidth: 0, fontSize: 13.5, overflowWrap: "anywhere" }}>
            {i.label}
            {i.detail && (
              <span className="loki-meta" style={{ marginLeft: 8 }}>
                {i.detail}
              </span>
            )}
          </span>
        </label>
      ))}
    </div>
  );
}
