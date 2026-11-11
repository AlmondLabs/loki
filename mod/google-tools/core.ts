import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { GoogleService } from "../../core/frame-types.ts";
import type { ModTool, ToolContext } from "../../daemon/mods/api.ts";
import { accountIdOf, accountLabel, servicesOf, type Accounts, type AccountRecord } from "../accounts.ts";
import type { GmailClient } from "../gmail.ts";
import { signInAgainFor, type GoogleAuth } from "../google-auth.ts";

/**
 * What every Google tool shares (plan 2026-11-11 scripts, U7): finding the account a call is for and checking, at the
 * moment of the call, that the calling chat's agent may use it (KTD12); the chat's folder for files (KTD13); full
 * listings saved to the chat's tool-results folder; and checksums. The tools are script-only: the model never sees
 * them, and an ACP chat is never served them (daemon/acp/loki-tools.ts).
 */

/** What the Google tools are built from; each account's sign-in and Gmail client are the mod's shared ones (mod/index.ts). */
export interface GoogleToolDeps {
  accounts: Accounts;
  auth: (accountId: string) => GoogleAuth;
  gmail: (accountId: string) => GmailClient;
  /** The paired Mac that holds an account, or null (PeerAccounts.heldBy). */
  heldElsewhere?: (accountId: string) => string | null;
  /** The folder a chat's full listings go in: `<loki>/tool-results/<chat>/`. */
  resultsDir: (chatId: string) => string;
  now?: () => Date;
}

/** A Google tool as its file writes it; `register` turns it into a script-only mod tool. */
export interface GoogleToolDef {
  name: string;
  description: string;
  /** JSON Schema properties of the tool's own arguments; `account` is added to every tool. */
  properties: Record<string, object>;
  required?: string[];
  /** The service whose grant the call needs; null for a tool that needs none (the accounts listing). */
  service: GoogleService | null;
  /** Reads only: safe to run again after a restart, and a read for the permission modes. */
  reads: boolean;
  run: (call: GoogleCall) => Promise<Record<string, unknown>>;
}

/** One call of a Google tool: its arguments, the chat, and the account it was checked for. */
export interface GoogleCall {
  args: Record<string, unknown>;
  ctx: ToolContext;
  /** Checked for the calling agent; for a tool whose `service` is null, without a service grant. */
  account: AccountRecord;
  auth: GoogleAuth;
  deps: GoogleToolDeps;
}

const ACCOUNT_PROPERTY = {
  type: "string",
  description: "The Google account's address; leave it out when this agent owns one Google account on this Mac.",
};

/** The Google accounts an agent owns on this Mac. */
export const googleAccountsOf = (accounts: Accounts, agentId: string): AccountRecord[] => accounts.ownedBy(agentId).filter((a) => a.provider === "gmail");

/**
 * The account a call is for, checked in this order, each with its own reason (KTD12): it belongs to the calling
 * chat's agent, it is on this Mac and not a paired one, it is connected, and its sign-in granted the service called.
 */
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

/** A Google tool as a script-only mod tool, its account checked before it runs. */
export function modToolOf(def: GoogleToolDef, deps: GoogleToolDeps): ModTool {
  return {
    name: def.name,
    description: def.description,
    parameters: { type: "object", properties: { account: ACCOUNT_PROPERTY, ...def.properties }, ...(def.required ? { required: def.required } : {}) },
    callers: ["tools"],
    outputSchema: { type: "object" },
    ...(def.reads ? { replay: "safe" as const, annotations: { readOnly: true } } : {}),
    forAgent: (agentId) => googleAccountsOf(deps.accounts, agentId).length > 0,
    execute: async (args, ctx) => {
      const account = accountFor(deps, ctx, args.account, def.service);
      return def.run({ args, ctx, account, auth: deps.auth(account.account_id), deps });
    },
  };
}

// --- arguments ---------------------------------------------------------------------------------------------------

/** A text argument; a required one that is missing fails the call with its name. */
export function textArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  throw new Error(`\`${key}\` is required`);
}

/** An optional text argument; empty is absent. */
export const optText = (args: Record<string, unknown>, key: string): string | undefined => {
  const v = args[key];
  return typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined;
};

/** A list of texts, from an array or one text. */
export const textList = (args: Record<string, unknown>, key: string): string[] => {
  const v = args[key];
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : [];
};

/** Whether a yes-or-no argument is yes; anything but `true` is no. */
export const flag = (args: Record<string, unknown>, key: string): boolean => args[key] === true;

/** A whole number within bounds, or the default. */
export function count(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const v = args[key];
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? Math.min(v, max) : fallback;
}

/** A value from Google's JSON as text; anything else is empty. */
export const str = (v: unknown): string => (typeof v === "string" ? v : "");
/** A value from Google's JSON as a list; anything else is empty. */
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);
/** A value from Google's JSON as an object; anything else is empty. */
export const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});

// --- files ---------------------------------------------------------------------------------------------------------

/**
 * A path in the chat's folder (R20): relative paths start there, and a path that leads out of it is refused, so a
 * script moves files only where the chat works.
 */
export function inChatFolder(ctx: ToolContext, path: string): string {
  if (!ctx.cwd) throw new Error("this chat has no folder to keep files in: set one for the chat first");
  const full = resolve(ctx.cwd, path);
  const rel = relative(resolve(ctx.cwd), full);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${path} is outside this chat's folder (${ctx.cwd})`);
  return full;
}

/** Write bytes to a path in the chat's folder, its folders made as needed; the full path. */
export async function writeInChat(ctx: ToolContext, path: string, data: Uint8Array): Promise<string> {
  const full = inChatFolder(ctx, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, data);
  return full;
}

/** Read a file in the chat's folder. */
export async function readInChat(ctx: ToolContext, path: string): Promise<{ full: string; data: Uint8Array<ArrayBuffer> }> {
  const full = inChatFolder(ctx, path);
  const data = await readFile(full).catch(() => {
    throw new Error(`there is no file ${path} in this chat's folder`);
  });
  return { full, data: new Uint8Array(data) };
}

/** A file's MD5, as Drive reports its own (`md5Checksum`). */
export const md5 = (data: Uint8Array): string => createHash("md5").update(data).digest("hex");

let listed = 0;

/**
 * A full listing kept whole in the chat's tool-results folder (R19), where the agent reads it with its file tools; the
 * script gets the path and a short copy, so a long listing never fills its output or the model's context.
 */
export async function saveListing(call: GoogleCall, name: string, items: unknown[]): Promise<string> {
  const dir = call.deps.resultsDir(call.ctx.chatId);
  await mkdir(dir, { recursive: true });
  const at = (call.deps.now?.() ?? new Date()).getTime().toString(36);
  const file = join(dir, `${name}-${at}-${++listed}.json`);
  await writeFile(file, `${JSON.stringify(items, null, 2)}\n`);
  return file;
}

/** How many items a listing's short copy keeps. */
export const SHORT_LISTING = 20;

/**
 * Every page of a listing, or one: `page` fetches one page by its token, and each answer names the next. With
 * `allPages` the whole listing is saved to a file and the answer keeps its first SHORT_LISTING items.
 */
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
    const one = await page(token);
    items.push(...one.items);
    token = one.next;
  } while (token);
  const file = await saveListing(call, name, items);
  return { count: items.length, items: items.slice(0, SHORT_LISTING), file };
}
