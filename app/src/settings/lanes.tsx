import { useEffect, useEffectEvent, useState } from "react";
import { MONDAY_FIRST, timesLabel, weekdayName } from "../../../core/attention/lane-times.ts";
import type { Lane, LaneSide, LaneWindow } from "../../../core/attention/lanes.ts";
import type { AccountProvider, AccountView } from "../../../core/frame-types.ts";
import type { MacAccountView } from "../../../core/frames.ts";
import { Button, Chip, Field, Sheet } from "../components";
import type { AgentName } from "./accounts";
import { Block, Segmented, Setting } from "./layout";

export interface LanesApi {
  lanes: Lane[] | null;
  set: (lanes: Lane[]) => void;
}

export interface LaneAccountsApi {
  everywhere: () => Promise<{ accounts: AccountView[]; other_macs: MacAccountView[] } | string>;
}

export interface LanesProps {
  lanes: LanesApi;
  accounts: LaneAccountsApi;
  agents: readonly AgentName[];
  newId?: () => string;
  now?: () => Date;
}

export type SideChoice = "all" | "pick" | "none";

export interface LaneDraft {
  id: string;
  name: string;
  chats: SideChoice;
  chatIds: string[];
  accounts: SideChoice;
  accountIds: string[];
  times: TimeDraft[];
}

export interface TimeDraft {
  days: number[];
  start: string;
  end: string;
  was: LaneWindow | null;
  key: string;
}

export interface LaneRefusal {
  message: string;
  time: number | null;
}

export interface LaneAccount {
  account_id: string;
  label: string;
  service: string;
  owner: string;
  mac: string | null;
}

const SERVICE: Record<AccountProvider, string> = { gmail: "Gmail", slack: "Slack", jira: "Jira" };

const SIDE_CHOICES: readonly SideChoice[] = ["all", "pick", "none"];

const POLL_MS = 3000;

const newLaneId = () => `lane-${crypto.randomUUID()}`;

const choiceOf = (side: LaneSide): SideChoice => (side === "all" ? "all" : side.length ? "pick" : "none");
const sideOf = (choice: SideChoice, ids: string[]): LaneSide => (choice === "all" ? "all" : choice === "pick" ? ids : []);

export function draftOf(lane: Lane): LaneDraft {
  return {
    id: lane.id,
    name: lane.name,
    chats: choiceOf(lane.chats),
    chatIds: lane.chats === "all" ? [] : [...lane.chats],
    accounts: choiceOf(lane.accounts),
    accountIds: lane.accounts === "all" ? [] : [...lane.accounts],
    times: (lane.times ?? []).map((w) => ({ days: [...w.days], start: w.start, end: w.end, was: w, key: nextTimeKey() })),
  };
}

export function newDraft(id: string): LaneDraft {
  return { id, name: "", chats: "pick", chatIds: [], accounts: "pick", accountIds: [], times: [] };
}

let timeKeys = 0;
const nextTimeKey = () => `time-${++timeKeys}`;

export function withNewTime(draft: LaneDraft): LaneDraft {
  return { ...draft, times: [...draft.times, { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", was: null, key: nextTimeKey() }] };
}

const sameDays = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((d) => b.includes(d));

function savedTime(t: TimeDraft, since: string): LaneWindow {
  const days = [...new Set(t.days)].sort((a, b) => a - b);
  if (t.was && sameDays(t.was.days, days) && t.was.start === t.start && t.was.end === t.end) return t.was;
  return { ...t.was, days, start: t.start, end: t.end, since };
}

export function saveLane(lanes: readonly Lane[], draft: LaneDraft, now: Date): Lane[] | LaneRefusal {
  const name = draft.name.trim();
  if (!name) return { message: "A lane needs a name", time: null };
  const other = lanes.find((l) => l.id !== draft.id && l.name.trim().toLowerCase() === name.toLowerCase());
  if (other) return { message: `Another lane is called ${other.name}`, time: null };
  const bad = draft.times.findIndex((t) => t.days.length === 0 || t.start === t.end);
  if (bad >= 0) return { message: draft.times[bad].days.length === 0 ? "Pick at least one day" : "Start and end must differ", time: bad };
  const { times: _was, ...opened }: Partial<Lane> = lanes.find((l) => l.id === draft.id) ?? {};
  const since = now.toISOString();
  const times = draft.times.map((t) => savedTime(t, since));
  const lane: Lane = {
    ...opened,
    id: draft.id,
    name,
    chats: sideOf(draft.chats, draft.chatIds),
    accounts: sideOf(draft.accounts, draft.accountIds),
    ...(times.length > 0 ? { times } : {}),
  };
  return lanes.some((l) => l.id === draft.id) ? lanes.map((l) => (l.id === draft.id ? lane : l)) : [...lanes, lane];
}

export function withoutLane(lanes: readonly Lane[], id: string): Lane[] {
  return lanes.filter((l) => l.id !== id);
}

export function ticked(ids: readonly string[], id: string, on: boolean): string[] {
  const rest = ids.filter((i) => i !== id);
  return on ? [...rest, id] : rest;
}

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

const inWords = (names: readonly string[]) => (names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

export function laneSummary(lane: Lane, agents: readonly AgentName[]): string {
  const names = lane.chats === "all" ? [] : lane.chats.flatMap((id) => agents.find((g) => g.id === id)?.name ?? []);
  const elsewhere = lane.chats === "all" ? 0 : lane.chats.length - names.length;
  const from = [...names, ...(elsewhere ? [elsewhere === 1 ? "an agent on another Mac" : `${elsewhere} agents on other Macs`] : [])];
  const chats = lane.chats === "all" ? "All chats" : from.length ? `Chats from ${inWords(from)}` : "No chats";
  const n = lane.accounts === "all" ? 0 : lane.accounts.length;
  const mail = lane.accounts === "all" ? "all mail and Slack" : n ? `mail and Slack from ${n === 1 ? "one account" : `${n} accounts`}` : "no mail or Slack";
  return `${chats}, ${mail}`;
}

export function Lanes({ lanes: api, accounts, agents, newId = newLaneId, now = () => new Date() }: LanesProps) {
  const [draft, setDraft] = useState<LaneDraft | null>(null);
  const choices = useLaneAccounts(accounts, agents, draft !== null);
  const [error, setError] = useState<LaneRefusal | null>(null);
  const { lanes, set } = api;
  const help =
    "A lane shows Flow only some agents' chats and some accounts' mail and Slack; you switch lanes from the sidebar under Flow on a Mac and from Flow's title on the phone.";
  if (!lanes)
    return (
      <Block title="Lanes" help={help}>
        <Setting label="Lanes" help="Asking loki…" />
      </Block>
    );
  const open = (d: LaneDraft) => {
    setDraft(d);
    setError(null);
  };
  const close = () => {
    setDraft(null);
    setError(null);
  };
  const save = (d: LaneDraft) => {
    const next = saveLane(lanes, d, now());
    if (!Array.isArray(next)) return setError(next);
    set(next);
    close();
  };
  const saved = draft !== null && lanes.some((l) => l.id === draft.id);
  return (
    <Block title="Lanes" help={help}>
      {lanes.length === 0 && <Setting label="No lanes yet" help="Flow shows all your work until you add one." />}
      {lanes.map((l) => (
        <Setting
          key={l.id}
          label={l.name}
          help={
            l.times?.length ? (
              <>
                <div>{laneSummary(l, agents)}</div>
                <div>{timesLabel(l.times)}</div>
              </>
            ) : (
              laneSummary(l, agents)
            )
          }
        >
          <Button size="sm" aria-label={`Edit ${l.name}`} onClick={() => open(draftOf(l))}>
            Edit…
          </Button>
        </Setting>
      ))}
      <div className="flex justify-end" style={{ padding: "12px 0" }}>
        <Button size="sm" onClick={() => open(newDraft(newId()))}>
          Add Lane…
        </Button>
      </div>
      {draft && (
        <Sheet label={saved ? `Edit ${lanes.find((l) => l.id === draft.id)?.name ?? "lane"}` : "New lane"} onClose={close} width={520} top="12vh">
          <LaneEditor
            key={draft.id}
            draft={draft}
            lanes={lanes}
            agents={agents}
            accounts={choices}
            error={error}
            onDraft={open}
            onSave={() => save(draft)}
            onCancel={close}
            onDelete={
              saved
                ? () => {
                    set(withoutLane(lanes, draft.id));
                    close();
                  }
                : null
            }
          />
        </Sheet>
      )}
    </Block>
  );
}

export function LaneEditor({
  draft,
  lanes,
  agents,
  accounts,
  error,
  onDraft,
  onSave,
  onCancel,
  onDelete,
}: {
  draft: LaneDraft;
  lanes: readonly Lane[];
  agents: readonly AgentName[];
  accounts: LaneAccount[] | string | null;
  error: LaneRefusal | null;
  onDraft: (d: LaneDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: (() => void) | null;
}) {
  const [confirm, setConfirm] = useState(false);
  const saved = lanes.find((l) => l.id === draft.id)?.name;
  const title = saved ?? "the new lane";
  const nameError = error?.time === null ? error.message : null;
  const setTime = (i: number, change: Partial<TimeDraft>) => onDraft({ ...draft, times: draft.times.map((t, j) => (j === i ? { ...t, ...change } : t)) });
  return (
    <form
      aria-label={saved ? `Edit ${saved}` : "New lane"}
      className="grid gap-3"
      style={{ padding: 16 }}
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <div style={{ fontSize: "var(--text-base)", fontWeight: 700, color: "var(--loki-fg)" }}>{saved ? `Edit ${saved}` : "New lane"}</div>
      <Field
        size="sm"
        name="lane-name"
        aria-label="Lane name"
        placeholder="Name, like Work"
        autoComplete="off"
        value={draft.name}
        aria-invalid={nameError ? true : undefined}
        onChange={(e) => onDraft({ ...draft, name: e.target.value })}
      />
      {nameError && (
        <div role="alert" className="loki-meta loki-meta--negative loki-meta--wrap">
          {nameError}
        </div>
      )}
      <div className="loki-settings-block">
        <Setting label="Chats" help="All takes in agents added later.">
          <Segmented
            label={`Chats in ${title}`}
            options={SIDE_CHOICES}
            value={draft.chats}
            onPick={(chats) => onDraft({ ...draft, chats })}
            labels={{ all: "All Agents", pick: "Pick", none: "None" }}
          />
        </Setting>
        {draft.chats === "pick" && (
          <Picks
            label={`Agents in ${title}`}
            items={agents.map((g) => ({ id: g.id, label: g.name, detail: null }))}
            ids={draft.chatIds}
            onTick={(id, on) => onDraft({ ...draft, chatIds: ticked(draft.chatIds, id, on) })}
            empty="No agents yet."
          />
        )}
        <Setting label="Mail and Slack" help="All takes in accounts connected later, on every Mac.">
          <Segmented
            label={`Mail and Slack in ${title}`}
            options={SIDE_CHOICES}
            value={draft.accounts}
            onPick={(side) => onDraft({ ...draft, accounts: side })}
            labels={{ all: "All Accounts", pick: "Pick", none: "None" }}
          />
        </Setting>
        {draft.accounts === "pick" &&
          (typeof accounts === "string" ? (
            <div className="loki-meta loki-meta--negative loki-meta--wrap" style={{ paddingBottom: 12 }}>
              {accounts}
            </div>
          ) : accounts === null ? (
            <span className="loki-meta" style={{ paddingBottom: 12 }}>
              Asking loki…
            </span>
          ) : (
            <Picks
              label={`Accounts in ${title}`}
              items={accounts.map((a) => ({ id: a.account_id, label: a.label, detail: [a.service, a.owner, a.mac].filter(Boolean).join(" · ") }))}
              ids={draft.accountIds}
              onTick={(id, on) => onDraft({ ...draft, accountIds: ticked(draft.accountIds, id, on) })}
              empty="No accounts yet: connect one in Preferences › Accounts."
            />
          ))}
      </div>
      <div className="loki-settings-block">
        <Setting label="Schedule" help="Every Mac and your phone switch to this lane at these times, from the first start or end after you save." />
        {draft.times.map((t, i) => (
          <TimeRow
            key={t.key}
            n={i + 1}
            time={t}
            error={error?.time === i ? error.message : null}
            onChange={(change) => setTime(i, change)}
            onRemove={() => onDraft({ ...draft, times: draft.times.filter((_, j) => j !== i) })}
          />
        ))}
        <div className="flex justify-end" style={{ padding: "12px 0" }}>
          <Button size="sm" onClick={() => onDraft(withNewTime(draft))}>
            Add Time
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2" style={{ paddingTop: 4 }}>
        {onDelete &&
          (confirm ? (
            <>
              <Button size="sm" tone="negative" onClick={onDelete}>
                Delete {title}
              </Button>
              <Button size="sm" onClick={() => setConfirm(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => setConfirm(true)}>
              Delete Lane…
            </Button>
          ))}
        <span className="flex-1" />
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" tone="positive" type="submit">
          Save
        </Button>
      </div>
    </form>
  );
}

function TimeRow({
  n,
  time,
  error,
  onChange,
  onRemove,
}: {
  n: number;
  time: TimeDraft;
  error: string | null;
  onChange: (change: Partial<TimeDraft>) => void;
  onRemove: () => void;
}) {
  const clock = (which: "start" | "end", label: string) => (
    <Field
      size="sm"
      type="time"
      aria-label={`${label} of time ${n}`}
      value={time[which]}
      style={{ width: "auto" }}
      onChange={(e) => {
        const value = e.target.value;
        if (value) onChange(which === "start" ? { start: value } : { end: value });
      }}
    />
  );
  return (
    <div className="grid gap-2" style={{ padding: "12px 0" }}>
      <div role="group" aria-label={`Days of time ${n}`} className="flex flex-wrap gap-1">
        {MONDAY_FIRST.map((d) => {
          const on = time.days.includes(d);
          return (
            <Chip key={d} active={on} aria-pressed={on} onClick={() => onChange({ days: on ? time.days.filter((x) => x !== d) : [...time.days, d] })}>
              {weekdayName(d)}
            </Chip>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        {clock("start", "Start")}
        <span className="loki-meta" aria-hidden="true">
          –
        </span>
        {clock("end", "End")}
        <span className="flex-1" />
        <Button size="sm" aria-label={`Remove time ${n}`} onClick={onRemove}>
          Remove
        </Button>
      </div>
      {error && (
        <div role="alert" className="loki-meta loki-meta--negative loki-meta--wrap">
          {error}
        </div>
      )}
    </div>
  );
}

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
  if (!items.length)
    return (
      <span className="loki-meta loki-meta--wrap" style={{ paddingBottom: 12 }}>
        {empty}
      </span>
    );
  return (
    <div role="group" aria-label={label} className="grid gap-1" style={{ paddingBottom: 12 }}>
      {items.map((i) => (
        <label key={i.id} className="grid grid-cols-[auto_1fr] items-baseline gap-2" style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={ids.includes(i.id)} onChange={(e) => onTick(i.id, e.target.checked)} aria-label={`Pick ${i.label}`} />
          <span className="min-w-0" style={{ fontSize: "var(--text-sm)", overflowWrap: "anywhere" }}>
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
