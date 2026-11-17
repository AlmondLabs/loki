import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { GoogleService } from "../../core/frame-types.ts";
import type { ModTool, ToolContext } from "../../daemon/mods/api.ts";
import { accountIdOf, accountLabel, servicesOf, type Accounts, type AccountRecord } from "../accounts.ts";
import type { GmailClient } from "../gmail.ts";
import { signInAgainFor, type GoogleAuth } from "../google-auth.ts";

export interface GoogleToolDeps {
  accounts: Accounts;
  auth: (accountId: string) => GoogleAuth;
  gmail: (accountId: string) => GmailClient;
  heldElsewhere?: (accountId: string) => string | null;
  resultsDir: (chatId: string) => string;
  now?: () => Date;
}

export interface GoogleToolDef {
  name: string;
  description: string;
  properties: Record<string, object>;
  required?: string[];
  service: GoogleService | null;
  reads: boolean;
  answersContent?: boolean;
  run: (call: GoogleCall) => Promise<Record<string, unknown>>;
}

export interface GoogleCall {
  args: Record<string, unknown>;
  ctx: ToolContext;
  account: AccountRecord;
  auth: GoogleAuth;
  deps: GoogleToolDeps;
}

const ACCOUNT_PROPERTY = {
  type: "string",
  description: "The Google account's address; leave it out when this agent owns one Google account on this Mac.",
};

export const googleAccountsOf = (accounts: Accounts, agentId: string): AccountRecord[] => accounts.ownedBy(agentId).filter((a) => a.provider === "gmail");

export function accountFor(deps: GoogleToolDeps, ctx: ToolContext, named: unknown, service: GoogleService | null): AccountRecord {
  const owned = googleAccountsOf(deps.accounts, ctx.agentId);
  let account: AccountRecord;
  if (typeof named === "string" && named.trim()) {
    const accountId = named.startsWith("gmail:") ? named.toLowerCase() : accountIdOf({ provider: "gmail", address: named });
    const here = deps.accounts.get(accountId);
    const address = accountId.replace(/^gmail:/, "");
    if (!here) {
      const elsewhere = deps.heldElsewhere?.(accountId);
      throw new Error(elsewhere ? `${address} lives on ${elsewhere}: scripts reach the accounts on this Mac only` : `${address} is not connected to loki`);
    }
    if (here.owner_agent_id !== ctx.agentId) throw new Error(`${address} is not this agent's account: only the agent that owns it may use it`);
    account = here;
  } else {
    if (owned.length === 0) throw new Error("this agent owns no Google account on this Mac");
    if (owned.length > 1) throw new Error(`this agent owns several Google accounts: name one with \`account\` (${owned.map((a) => a.address).join(", ")})`);
    account = owned[0];
  }
  if (account.status !== "connected") throw new Error(`${accountLabel(account)} is disconnected: reconnect it in Preferences › Accounts`);
  if (service && !servicesOf(account).includes(service)) throw new Error(signInAgainFor(service));
  return account;
}

export function modToolOf(def: GoogleToolDef, deps: GoogleToolDeps): ModTool {
  return {
    name: def.name,
    description: def.description,
    parameters: { type: "object", properties: { account: ACCOUNT_PROPERTY, ...def.properties }, ...(def.required ? { required: def.required } : {}) },
    callers: ["tools"],
    outputSchema: { type: "object" },
    ...(def.reads
      ? { replay: "safe" as const, annotations: { readOnly: true, strangerText: true } }
      : def.answersContent
        ? { annotations: { strangerText: true } }
        : {}),
    forAgent: (agentId) => googleAccountsOf(deps.accounts, agentId).length > 0,
    execute: async (args, ctx) => {
      const account = accountFor(deps, ctx, args.account, def.service);
      return def.run({ args, ctx, account, auth: deps.auth(account.account_id), deps });
    },
  };
}

export function textArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  throw new Error(`\`${key}\` is required`);
}

export const optText = (args: Record<string, unknown>, key: string): string | undefined => {
  const v = args[key];
  return typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined;
};

export const textList = (args: Record<string, unknown>, key: string): string[] => {
  const v = args[key];
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : [];
};

export const flag = (args: Record<string, unknown>, key: string): boolean => args[key] === true;

export function count(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const v = args[key];
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? Math.min(v, max) : fallback;
}

export const str = (v: unknown): string => (typeof v === "string" ? v : "");
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);
export const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});

export function inChatFolder(ctx: Pick<ToolContext, "cwd">, path: string): string {
  if (!ctx.cwd) throw new Error("this chat has no folder to keep files in: set one for the chat first");
  const full = resolve(ctx.cwd, path);
  const rel = relative(resolve(ctx.cwd), full);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${path} is outside this chat's folder (${ctx.cwd})`);
  return full;
}

export async function writeInChat(ctx: ToolContext, path: string, data: Uint8Array): Promise<string> {
  const full = inChatFolder(ctx, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, data);
  return full;
}

export async function readInChat(ctx: ToolContext, path: string): Promise<{ full: string; data: Uint8Array<ArrayBuffer> }> {
  const full = inChatFolder(ctx, path);
  const data = await readFile(full).catch(() => {
    throw new Error(`there is no file ${path} in this chat's folder`);
  });
  return { full, data: new Uint8Array(data) };
}

export function fileTypeOf(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const types: Record<string, string> = {
    pdf: "application/pdf",
    csv: "text/csv",
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip: "application/zip",
  };
  return types[ext] ?? "application/octet-stream";
}

export const md5 = (data: Uint8Array): string => createHash("md5").update(data).digest("hex");

let listed = 0;

export async function saveListing(call: GoogleCall, name: string, items: unknown[]): Promise<string> {
  const dir = call.deps.resultsDir(call.ctx.chatId);
  await mkdir(dir, { recursive: true });
  const at = (call.deps.now?.() ?? new Date()).getTime().toString(36);
  const file = join(dir, `${name}-${at}-${++listed}.json`);
  await writeFile(file, `${JSON.stringify(items, null, 2)}\n`);
  return file;
}

export const MAX_LISTING_ITEMS = 50_000;

export const SHORT_LISTING = 20;

export async function listing(
  call: GoogleCall,
  name: string,
  allPages: boolean,
  page: (token: string | undefined) => Promise<{ items: unknown[]; next: string | undefined }>,
  firstToken?: string,
): Promise<Record<string, unknown>> {
  if (!allPages) {
    const one = await page(firstToken);
    return { items: one.items, ...(one.next ? { next_page: one.next } : {}) };
  }
  const items: unknown[] = [];
  let token: string | undefined = firstToken;
  do {
    call.ctx.signal.throwIfAborted();
    const one = await page(token);
    items.push(...one.items);
    token = one.next;
  } while (token && items.length < MAX_LISTING_ITEMS);
  const file = await saveListing(call, name, items);
  return { count: items.length, items: items.slice(0, SHORT_LISTING), file, ...(token ? { truncated: true, next_page: token } : {}) };
}
