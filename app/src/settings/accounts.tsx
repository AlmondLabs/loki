import { useEffect, useEffectEvent, useState } from "react";
import type { AccountProvider, AccountView, SlackWorkspaceView } from "../../../core/frame-types.ts";
import { Button, Dot, Field } from "../components";
import { disconnectedText } from "../desk/outside-card";
import { notYetOn, openExternal, platform, type Platform } from "../desk/env";
import { Block, Fold, Setting } from "./layout";

/**
 * Preferences › Accounts (plan 067, U11): the Gmail mailboxes and Slack workspaces whose mail and messages reach
 * the Inbox, each owned by one agent. Connecting asks for the owner first (R2); an account can move to another agent
 * (R3) or be disconnected, and one that stopped working says why and how to get it back (R22).
 */

/** What Preferences › Accounts asks of the daemon about accounts (core/daemon-calls.ts); each call answers, or says why not. */
export interface AccountsApi {
  list: () => Promise<AccountView[] | string>;
  move: (accountId: string, ownerAgentId: string) => Promise<AccountView[] | string>;
  disconnect: (accountId: string) => Promise<AccountView[] | string>;
  /** Google's sign-in page for a mailbox the agent will own, through loki's shared Google app or the person's own. */
  connectGmail: (ownerAgentId: string, ownApp: OwnApp | null) => Promise<{ url: string } | string>;
  /** Without a team, the workspaces signed in to the Slack desktop app; with one, that workspace connected. */
  connectSlack: (ownerAgentId: string, teamId?: string) => Promise<{ workspaces: SlackWorkspaceView[]; account: AccountView | null } | string>;
}

/** The person's own Google app, used in place of loki's shared one (R20). */
export interface OwnApp {
  client_id: string;
  client_secret: string;
}

/** An agent as the owner pickers name it. */
export interface AgentName {
  id: string;
  name: string;
}

/** How a disconnected account comes back: Gmail signs in again; Slack connects its workspace again. */
export interface Reconnect {
  provider: AccountProvider;
  owner_agent_id: string;
  /** The Slack workspace to connect again; null for Gmail. */
  team_id: string | null;
}

/** One account's row: what it is, who owns it, whether it works, and the way back when it does not. */
export interface AccountRow {
  account_id: string;
  label: string;
  service: string;
  owner_agent_id: string;
  /** The owner's name, or a plain line when that agent is gone. */
  owner: string;
  state: string;
  problem: boolean;
  reconnect: Reconnect | null;
}

const SERVICE: Record<AccountProvider, string> = { gmail: "Gmail", slack: "Slack", jira: "Jira" };

/** How often the list is asked again while the page shows: a Gmail sign-in finishes in the browser, and accounts can stop working. */
const POLL_MS = 3000;

/** Whether connecting can start: an owner must be chosen first, and Slack is read from the desktop app on a Mac only. */
export function connectState(provider: AccountProvider, owner: string | null, os: Platform): { ready: boolean; reason: string | null } {
  if (provider === "slack" && os !== "macos") return { ready: false, reason: notYetOn("Connecting Slack", os) };
  if (!owner) return { ready: false, reason: "add an agent first: an account belongs to one" };
  return { ready: true, reason: null };
}

/** The Slack workspace in an account id, `slack:<team_id>:<user_id>`; null for any other. */
const teamOf = (accountId: string): string | null => /^slack:([^:]+):/.exec(accountId)?.[1] ?? null;

/** The accounts as rows: the owner by name, the state in words, and a reconnect wherever the person can bring it back. */
export function accountRows(accounts: readonly AccountView[], agents: readonly AgentName[]): AccountRow[] {
  return accounts.map((a) => {
    const cause = a.status === "connected" ? null : a.status.disconnected;
    // A service failing for now comes back on its own; every other cause needs the person to connect again.
    const reconnect: Reconnect | null =
      cause && cause !== "temporarily_failing"
        ? { provider: a.provider, owner_agent_id: a.owner_agent_id, team_id: a.provider === "slack" ? teamOf(a.account_id) : null }
        : null;
    return {
      account_id: a.account_id,
      label: a.address,
      service: SERVICE[a.provider],
      owner_agent_id: a.owner_agent_id,
      owner: agents.find((g) => g.id === a.owner_agent_id)?.name ?? "an agent no longer here",
      state: cause ? disconnectedText(cause, a.provider) : "connected",
      problem: cause !== null,
      reconnect,
    };
  });
}

/** The own Google app as the sign-in takes it: both fields filled in, trimmed; otherwise null, and loki's shared app is used. */
export function ownAppOf(clientId: string, clientSecret: string): OwnApp | null {
  const id = clientId.trim();
  const secret = clientSecret.trim();
  return id && secret ? { client_id: id, client_secret: secret } : null;
}

/** The accounts an agent owns, each to be moved or disconnected before the agent can be deleted (R4, AE5). */
export function deleteBlockers(accounts: readonly AccountView[], agentId: string): AccountView[] {
  return accounts.filter((a) => a.owner_agent_id === agentId);
}

/** The agents an account can move to: every one but its owner. */
export function moveTargets(agents: readonly AgentName[], ownerId: string): AgentName[] {
  return agents.filter((g) => g.id !== ownerId);
}

/** A choice of agent; empty until one is picked when `placeholder` is given. */
export function AgentPicker({
  agents,
  value,
  onPick,
  label,
  placeholder,
}: {
  agents: readonly AgentName[];
  value: string | null;
  onPick: (agentId: string) => void;
  label: string;
  placeholder?: string;
}) {
  return (
    <select
      aria-label={label}
      value={value ?? ""}
      onChange={(e) => e.target.value && onPick(e.target.value)}
      style={{ font: "inherit", color: "var(--loki-fg)" }}
    >
      {placeholder !== undefined && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {agents.map((g) => (
        <option key={g.id} value={g.id}>
          {g.name}
        </option>
      ))}
    </select>
  );
}

/** The accounts list, asked again every few seconds while the page shows; `apply` takes any call's answer. */
function useAccounts(api: AccountsApi) {
  const [accounts, setAccounts] = useState<AccountView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apply = (r: AccountView[] | string) => {
    if (typeof r === "string") return setError(r);
    setError(null);
    setAccounts(r);
  };
  const read = useEffectEvent(() => api.list());
  const take = useEffectEvent(apply);
  useEffect(() => {
    let live = true;
    const load = () => void read().then((r) => live && take(r));
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return { accounts, error, setError, apply };
}

/**
 * Preferences › Accounts (plan 068): each account with its service, owner and state, the owner changed in place and
 * "disconnect" on each; then "connect gmail" and "connect slack", with the agent a new account goes to beside them,
 * already set to the first agent. Gmail opens Google's page in the browser; Slack lists the workspaces signed in to its
 * desktop app to pick from.
 */
export function Accounts({ api, agents, os = platform }: { api: AccountsApi; agents: readonly AgentName[]; os?: Platform }) {
  const { accounts, error, setError, apply } = useAccounts(api);
  const [picked, setOwner] = useState<string | null>(null);
  // A new account goes to the agent picked, else the first one, so connecting never waits on a choice first.
  const owner = picked && agents.some((g) => g.id === picked) ? picked : (agents[0]?.id ?? null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<{ owner: string; list: SlackWorkspaceView[] } | null>(null);

  const gmail = async (ownerId: string) => {
    const r = await api.connectGmail(ownerId, ownAppOf(clientId, clientSecret));
    if (typeof r === "string") return setError(r);
    openExternal(r.url);
    setNotice("finish signing in to Google in your browser: the mailbox shows here once Google sends you back");
  };
  const slack = async (ownerId: string, teamId?: string) => {
    const r = await api.connectSlack(ownerId, teamId);
    if (typeof r === "string") return setError(r);
    if (r.account) {
      setWorkspaces(null);
      setNotice(null);
      return apply(await api.list());
    }
    setWorkspaces({ owner: ownerId, list: r.workspaces });
  };
  const reconnect = (r: Reconnect) => void (r.provider === "gmail" ? gmail(r.owner_agent_id) : slack(r.owner_agent_id, r.team_id ?? undefined));

  const rows = accountRows(accounts ?? [], agents);
  const connectedTeams = new Set((accounts ?? []).filter((a) => a.status === "connected").map((a) => teamOf(a.account_id)));
  const gmailState = connectState("gmail", owner, os);
  const slackState = connectState("slack", owner, os);
  return (
    <>
      <Block
        title="Accounts"
        help="mail and Slack messages addressed to you arrive as Inbox cards; each account belongs to one agent, which gets its hand-offs and its tools."
      >
        {error && <div className="loki-meta loki-meta--negative loki-meta--wrap">{error}</div>}
        {!accounts && !error && <Setting label="Accounts" help="asking loki…" />}
        {accounts && rows.length === 0 && <Setting label="None yet" help="Connect a Gmail account or a Slack workspace below." />}
        {rows.map((row) => (
          <AccountLine key={row.account_id} row={row} agents={agents} api={api} apply={apply} onReconnect={reconnect} />
        ))}
      </Block>
      <Block title="Connect an account" help="a mailbox or a workspace; it goes to the agent below, which you can change on its row later.">
        <Setting label="Gmail" help={gmailState.reason ?? "Opens Google's sign-in in your browser."}>
          <Button tone="positive" disabled={!gmailState.ready} onClick={() => owner && void gmail(owner)}>
            connect gmail
          </Button>
        </Setting>
        <Setting label="Slack" help={slackState.reason ?? "Reads the workspaces signed in to the Slack desktop app; no Slack app to create."}>
          <Button tone="positive" disabled={!slackState.ready} onClick={() => owner && void slack(owner)}>
            connect slack
          </Button>
        </Setting>
        <Setting label="Goes to" help="The agent that gets a new account's hand-offs, and the only one with tools for it.">
          <AgentPicker agents={agents} value={owner} onPick={setOwner} label="the agent a new account goes to" placeholder="choose an agent" />
        </Setting>
        {notice && <div className="loki-meta loki-meta--wrap">{notice}</div>}
        {workspaces?.list.length === 0 && <Setting label="No workspaces" help="Sign in to a workspace in the Slack desktop app, then connect slack again." />}
        {workspaces?.list.map((w) => (
          <Setting key={w.team_id} label={w.team_name} help={w.url} mono>
            {connectedTeams.has(w.team_id) ? (
              <span className="loki-meta">connected</span>
            ) : (
              <Button tone="positive" onClick={() => void slack(workspaces.owner, w.team_id)}>
                connect
              </Button>
            )}
          </Setting>
        ))}
      </Block>
      <Fold title="Use your own Google app">
        <Setting
          label="Client id and secret"
          help="From an OAuth client of your own in Google Cloud, for a desktop app. Filled in, connect gmail signs in with it instead of loki's shared app."
        />
        <Field value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="client id" placeholder="client id" mono />
        <Field
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          aria-label="client secret"
          placeholder="client secret"
          type="password"
          mono
          style={{ marginTop: 8 }}
        />
      </Fold>
    </>
  );
}

/** One account: its label, service, owner and state, with move, disconnect, and reconnect when it stopped working. */
function AccountLine({
  row,
  agents,
  api,
  apply,
  onReconnect,
}: {
  row: AccountRow;
  agents: readonly AgentName[];
  api: AccountsApi;
  apply: (r: AccountView[] | string) => void;
  onReconnect: (r: Reconnect) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const { reconnect } = row;
  return (
    <div style={{ display: "grid", gap: 6, padding: "12px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Dot color={row.problem ? "var(--loki-negative)" : "var(--loki-positive)"} />
        <strong style={{ fontSize: 13.5, minWidth: 0, overflowWrap: "anywhere" }}>{row.label}</strong>
        <span className="loki-meta">
          {row.service} · {row.owner}
        </span>
      </div>
      <div className={row.problem ? "loki-meta loki-meta--negative loki-meta--wrap" : "loki-meta loki-meta--wrap"}>{row.state}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {reconnect && (
          <Button tone="positive" onClick={() => onReconnect(reconnect)}>
            {`reconnect ${row.service.toLowerCase()}`}
          </Button>
        )}
        <label className="loki-meta" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          move to
          <AgentPicker
            agents={agents}
            value={agents.some((g) => g.id === row.owner_agent_id) ? row.owner_agent_id : null}
            onPick={(agentId) => void api.move(row.account_id, agentId).then(apply)}
            label={`the agent that owns ${row.label}`}
            placeholder="choose an agent"
          />
        </label>
        {confirm ? (
          <>
            <Button tone="negative" onClick={() => void api.disconnect(row.account_id).then(apply)}>
              disconnect {row.label}
            </Button>
            <Button onClick={() => setConfirm(false)}>keep it</Button>
          </>
        ) : (
          <Button onClick={() => setConfirm(true)}>disconnect</Button>
        )}
      </div>
    </div>
  );
}

/**
 * Before an agent that owns accounts is deleted (R4, AE5): each of its accounts, to move to another agent or disconnect.
 * Asked again whenever `asked` changes, so a refused delete shows what still stands in the way.
 */
export function OwnedAccounts({
  api,
  agentId,
  agents,
  asked,
  onOwned,
}: {
  api: AccountsApi;
  agentId: string;
  agents: readonly AgentName[];
  asked: number;
  /** How many accounts the agent still owns here, after each answer. */
  onOwned: (count: number) => void;
}) {
  const [owned, setOwned] = useState<AccountView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const apply = (r: AccountView[] | string) => {
    if (typeof r === "string") return setError(r);
    const mine = deleteBlockers(r, agentId);
    setError(null);
    setOwned(mine);
    onOwned(mine.length);
  };
  const take = useEffectEvent(apply);
  const read = useEffectEvent(() => api.list());
  useEffect(() => {
    let live = true;
    void read().then((r) => live && take(r));
    return () => {
      live = false;
    };
  }, [asked]);
  if (!owned.length && !error) return null;
  return (
    <div role="group" aria-label="accounts this agent owns" style={{ display: "grid", gap: 8 }}>
      {error && <span className="loki-meta loki-meta--negative loki-meta--wrap">{error}</span>}
      {owned.length > 0 && <span>It owns these accounts: move each to another agent or disconnect it first.</span>}
      {accountRows(owned, agents).map((row) => (
        <div key={row.account_id} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <strong style={{ minWidth: 0, overflowWrap: "anywhere" }}>{row.label}</strong>
          <span className="loki-meta">{row.service}</span>
          <label className="loki-meta" style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
            move to
            <AgentPicker
              agents={moveTargets(agents, agentId)}
              value={null}
              onPick={(to) => void api.move(row.account_id, to).then(apply)}
              label={`move ${row.label} to`}
              placeholder="choose an agent"
            />
          </label>
          <Button tone="negative" onClick={() => void api.disconnect(row.account_id).then(apply)}>
            disconnect
          </Button>
        </div>
      ))}
    </div>
  );
}
