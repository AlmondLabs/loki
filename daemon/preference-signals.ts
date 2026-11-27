import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "../mod/json-file.ts";

export const MIN_FLOW_MOVES = 10;
const MAX_LEDGER_READ_BYTES = 2 * 1024 * 1024;
const MAX_REPLY_ITEMS = 12;
const MAX_REPLY_CHARS = 4_000;
const MAX_FLOW_CHARS = 3_000;

interface ReplySignalItem {
  decided_at: string;
  line: string;
}

interface ParsedFlowEntry {
  at: string;
  provider: string;
  action: string;
  dwell_ms: number | null;
  sender: string;
  sender_address: string | null;
  traits: { automated?: boolean; list?: boolean } | null;
}

interface SenderStat {
  label: string;
  archive: number;
  read: number;
  later: number;
  engaged: number;
  dwells: number[];
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function collectReplySignals(stateDir: string, agentId: string, since: string | null): string | null {
  const raw = readJson(join(stateDir, "reply-proposals.json"));
  if (typeof raw !== "object" || raw === null) return null;
  const chats = (raw as { chats?: unknown }).chats;
  if (!Array.isArray(chats)) return null;

  const items: ReplySignalItem[] = [];
  for (const chat of chats) {
    if (typeof chat !== "object" || chat === null) continue;
    const chatObj = chat as Record<string, unknown>;
    if (chatObj.agent_id !== agentId || !Array.isArray(chatObj.proposals)) continue;
    for (const p of chatObj.proposals) {
      if (typeof p !== "object" || p === null) continue;
      const r = p as Record<string, unknown>;
      const decidedAt = str(r.decided_at);
      if (!decidedAt || (since && decidedAt <= since)) continue;
      const status = str(r.status);
      const provider = str(r.provider) ?? "unknown";
      const subject = str(r.subject) ?? "";
      const place = str(r.place) ?? "";
      const target = subject ? `"${clip(subject, 80)}"` : place ? clip(place, 80) : "thread";
      const text = str(r.text) ?? "";
      const proposedText = str(r.proposed_text);
      const proposedSubject = str(r.proposed_subject);

      if (status === "sent") {
        const subjectChanged = proposedSubject !== null && proposedSubject.trim() !== subject.trim();
        const textChanged = proposedText !== null && proposedText.trim() !== text.trim();
        if (!textChanged && !subjectChanged) continue;
        const parts = [`- [edited-send] ${provider} (${target}) @ ${decidedAt}`];
        if (subjectChanged) {
          parts.push(`  drafted-title: ${clip(proposedSubject, 120)}`);
          parts.push(`  sent-title: ${clip(subject, 120)}`);
        }
        if (textChanged) {
          parts.push(`  drafted: ${clip(proposedText, 400)}`);
          parts.push(`  sent: ${clip(text, 400)}`);
        }
        items.push({ decided_at: decidedAt, line: parts.join("\n") });
      } else if (status === "rejected") {
        items.push({
          decided_at: decidedAt,
          line: `- [rejected] ${provider} (${target}) @ ${decidedAt}\n  drafted: ${clip(text, 300)}`,
        });
      }
    }
  }

  if (!items.length) return null;
  items.sort((a, b) => b.decided_at.localeCompare(a.decided_at));

  const lines: string[] = [];
  let chars = 0;
  for (const item of items.slice(0, MAX_REPLY_ITEMS)) {
    const cost = item.line.length + (lines.length ? 1 : 0);
    if (lines.length > 0 && chars + cost > MAX_REPLY_CHARS) break;
    lines.push(item.line);
    chars += cost;
  }
  return lines.length ? `<reply-edits>\n${lines.join("\n")}\n</reply-edits>` : null;
}

function readLedgerTail(path: string): string {
  const size = statSync(path).size;
  if (size <= 0) return "";
  const start = Math.max(0, size - MAX_LEDGER_READ_BYTES);
  const length = size - start;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(length);
    const read = readSync(fd, buf, 0, length, start);
    const text = buf.subarray(0, read).toString("utf8");
    if (start === 0) return text;
    const nl = text.indexOf("\n");
    return nl >= 0 ? text.slice(nl + 1) : "";
  } finally {
    closeSync(fd);
  }
}

function medianMs(values: readonly number[]): string | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  return mid < 1000 ? `${Math.round(mid)}ms` : `${(mid / 1000).toFixed(1)}s`;
}

function collectFlowSignals(stateDir: string, agentId: string, since: string | null): string | null {
  const path = join(stateDir, "flow-ledger.jsonl");
  if (!existsSync(path)) return null;

  let raw = "";
  try {
    raw = readLedgerTail(path);
  } catch {
    return null;
  }
  if (!raw) return null;

  const entries: ParsedFlowEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed !== "object" || parsed === null) continue;
      const r = parsed as Record<string, unknown>;
      if (r.owner_agent_id !== agentId) continue;
      const at = str(r.at);
      const provider = str(r.provider);
      const action = str(r.action);
      const sender = str(r.sender);
      if (!at || !provider || !action || sender === null) continue;
      if (since && at <= since) continue;
      const rawTraits = typeof r.traits === "object" && r.traits !== null ? (r.traits as Record<string, unknown>) : null;
      entries.push({
        at,
        provider,
        action,
        dwell_ms: typeof r.dwell_ms === "number" && Number.isFinite(r.dwell_ms) ? r.dwell_ms : null,
        sender,
        sender_address: str(r.sender_address),
        traits: rawTraits ? { automated: rawTraits.automated === true, list: rawTraits.list === true } : null,
      });
    } catch {
      continue;
    }
  }

  if (entries.length < MIN_FLOW_MOVES) return null;

  const providers = new Map<string, number>();
  const actions = new Map<string, number>();
  const senders = new Map<string, SenderStat>();
  let automatedArchived = 0;
  let automatedEngaged = 0;
  let listArchived = 0;
  let listEngaged = 0;

  for (const e of entries) {
    providers.set(e.provider, (providers.get(e.provider) ?? 0) + 1);
    actions.set(e.action, (actions.get(e.action) ?? 0) + 1);
    const key = (e.sender_address || e.sender).trim().toLowerCase();
    if (key) {
      const label = e.sender_address ? (e.sender ? `${e.sender} <${e.sender_address}>` : e.sender_address) : e.sender;
      let stat = senders.get(key);
      if (!stat) {
        stat = { label: clip(label, 80), archive: 0, read: 0, later: 0, engaged: 0, dwells: [] };
        senders.set(key, stat);
      }
      if (e.action === "archive") stat.archive++;
      else if (e.action === "read" || e.action === "next") stat.read++;
      else if (e.action === "later") stat.later++;
      else if (e.action === "reply" || e.action === "handoff") stat.engaged++;
      if (e.dwell_ms !== null && e.action === "archive") stat.dwells.push(e.dwell_ms);
    }
    if (e.traits?.automated) {
      if (e.action === "archive") automatedArchived++;
      else if (e.action === "reply" || e.action === "handoff") automatedEngaged++;
    }
    if (e.traits?.list) {
      if (e.action === "archive") listArchived++;
      else if (e.action === "reply" || e.action === "handoff") listEngaged++;
    }
  }

  const fmtCounts = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");

  const lines: string[] = [`Moves (${entries.length}): providers [${fmtCounts(providers)}]; actions [${fmtCounts(actions)}]`];

  const allSenders = [...senders.values()];
  const fastArchived = allSenders
    .filter((s) => s.archive >= 3 && s.engaged === 0)
    .sort((a, b) => b.archive - a.archive || a.label.localeCompare(b.label))
    .slice(0, 8);
  if (fastArchived.length) {
    lines.push(
      `Consistently archived without reply/handoff: ${fastArchived
        .map((s) => {
          const med = medianMs(s.dwells);
          return `${s.label} (${s.archive} archived${med ? `, median ${med}` : ""})`;
        })
        .join("; ")}`,
    );
  }

  const engaged = allSenders
    .filter((s) => s.engaged >= 2)
    .sort((a, b) => b.engaged - a.engaged || a.label.localeCompare(b.label))
    .slice(0, 8);
  if (engaged.length) {
    lines.push(`Consistently engaged (reply/handoff): ${engaged.map((s) => `${s.label} (${s.engaged})`).join("; ")}`);
  }

  const deferred = allSenders
    .filter((s) => s.later >= 3)
    .sort((a, b) => b.later - a.later || a.label.localeCompare(b.label))
    .slice(0, 5);
  if (deferred.length) {
    lines.push(`Repeatedly deferred (later): ${deferred.map((s) => `${s.label} (${s.later})`).join("; ")}`);
  }

  if (automatedArchived + automatedEngaged > 0 || listArchived + listEngaged > 0) {
    lines.push(
      `Mail traits: automated (${automatedArchived} archived, ${automatedEngaged} engaged); mailing-list (${listArchived} archived, ${listEngaged} engaged)`,
    );
  }

  const body = lines.join("\n");
  return `<flow-patterns>\n${body.length > MAX_FLOW_CHARS ? `${body.slice(0, MAX_FLOW_CHARS)}…` : body}\n</flow-patterns>`;
}

export function collectPreferenceSignals(opts: { stateDir: string; agentId: string; since: string | null }): string | null {
  const parts = [collectReplySignals(opts.stateDir, opts.agentId, opts.since), collectFlowSignals(opts.stateDir, opts.agentId, opts.since)].filter(
    (part): part is string => part !== null,
  );
  return parts.length ? parts.join("\n\n") : null;
}
