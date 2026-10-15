import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Task } from "../../../core/frame-types.ts";
import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import { chipState, messageKey, quoteBlock, quoteOf, tasksByMessage, tasksForRow, titleFrom, type TaskSource } from "../../../core/task-source.ts";
import { Button, Field } from "../components";
import { formatKeys, matches } from "../shell/keymap";
import { takeReveal, useRevealAsk } from "./revealMessage";
import type { useDesk } from "../desk/useDesk";

/**
 * "Add task" on a chat message, as Slack's "Add to-do": from a message's action row (the phone: its long press), or
 * ⌘⇧T on text selected inside a message. An editor opens under the message with a title to start from; ⏎ files the
 * task, stamped with the message, and esc cancels. Every message that has a task shows its chip: open with the
 * agent's newest note, an agent's done? waiting for you, or done.
 */

/** What the window can do with tasks; the desktop's comes from useTasks, the phone's from useTaskList. */
export interface TaskApi {
  tasks: Task[] | null;
  create: (t: {
    title: string;
    description: string;
    source: TaskSource;
    desk: string | null;
    agentId: string | null;
    agentName: string | null;
    conversationId: string;
  }) => Promise<string | null>;
  /** The task in Tasks (the desktop); without it the chip only shows. */
  open?: (task: Task) => void;
  /** An agent's done?, answered from the chip (the desktop). */
  confirm?: (task: Task) => void;
  reopen?: (task: Task) => void;
}

/** The conversation the messages belong to. */
export interface TaskConversation {
  agentId: string | null;
  agentName: string | null;
  conversationId: string | null;
  desk: string | null;
}

/** The editor under one message: which message, what it files from (the message or a selection), the title so far. */
export interface Adding {
  key: string;
  role: "user" | "assistant";
  at: string | null;
  text: string;
  origin: TaskSource["origin"];
  title: string;
}

export interface MessageTasksValue {
  conversationId: string;
  tasksFor: (row: TranscriptRow) => Task[];
  adding: Adding | null;
  /** Open the editor under a message: the whole message, or the selected text in it. */
  start: (row: Pick<TranscriptRow, "role" | "text" | "at">, selection?: string) => void;
  setTitle: (title: string) => void;
  cancel: () => void;
  /** File the task; resolves to an error, or null once it is filed. */
  submit: () => Promise<string | null>;
  api: TaskApi;
}

export const MessageTasks = createContext<MessageTasksValue | null>(null);

export const useMessageTasks = () => useContext(MessageTasks);

/** The rows Add task works on: a message with words, yours or the agent's. */
const canAdd = <R extends Pick<TranscriptRow, "role" | "text">>(row: R): row is R & { role: "user" | "assistant" } =>
  (row.role === "user" || row.role === "assistant") && !!row.text.trim();

/**
 * The editor's start: the message (or the words selected in it) to file from, named by the whole message's key, and a
 * title drawn from what is filed. Null for a row Add task does not work on.
 */
export function addingFrom(row: Pick<TranscriptRow, "role" | "text" | "at">, selection?: string): Adding | null {
  if (!canAdd(row)) return null;
  const picked = selection?.trim();
  const text = picked || row.text;
  return { key: messageKey(row.role, row.text), role: row.role, at: row.at ?? null, text, origin: picked ? "selection" : "message", title: titleFrom(text) };
}

/**
 * One conversation's Add task: its tasks by message, the editor, and ⌘⇧T on a selection inside one of its messages.
 * Null without a conversation or tasks (nothing to stamp, nowhere to file).
 */
export function useMessageTasksScope(conversation: TaskConversation, api: TaskApi | null): MessageTasksValue | null {
  const { conversationId, agentId, agentName, desk } = conversation;
  const [adding, setAdding] = useState<Adding | null>(null);
  const tasks = api?.tasks;
  const byKey = useMemo(() => (conversationId ? tasksByMessage(tasks ?? [], conversationId) : new Map<string, Task[]>()), [tasks, conversationId]);
  const tasksFor = useCallback((row: TranscriptRow) => (canAdd(row) ? tasksForRow(byKey, row) : []), [byKey]);
  const start = useCallback((row: Pick<TranscriptRow, "role" | "text" | "at">, selection?: string) => {
    const next = addingFrom(row, selection);
    if (next) setAdding(next);
  }, []);
  const setTitle = useCallback((title: string) => setAdding((a) => (a ? { ...a, title } : a)), []);
  const cancel = useCallback(() => setAdding(null), []);
  const addingRef = useRef(adding);
  useEffect(() => {
    addingRef.current = adding;
  }, [adding]);
  const submit = useCallback(async (): Promise<string | null> => {
    const a = addingRef.current;
    if (!a || !api || !conversationId) return "nothing to file";
    if (!a.title.trim()) return "a task needs a title";
    const source: TaskSource = { origin: a.origin, role: a.role, key: a.key, at: a.at, quote: quoteOf(a.text) };
    const err = await api.create({ title: a.title.trim(), description: quoteBlock(a.text), source, desk, agentId, agentName, conversationId });
    if (err) return err;
    setAdding((now) => (now?.key === a.key ? null : now));
    return null;
  }, [api, conversationId, desk, agentId, agentName]);

  // ⌘⇧T with text selected inside one of this conversation's messages: a task from just the selection.
  useEffect(() => {
    if (!conversationId || !api) return;
    const onKey = (e: KeyboardEvent) => {
      if (!matches(e, "cmd+shift+t")) return;
      const picked = selectedMessage(conversationId);
      if (!picked) return;
      e.preventDefault();
      start({ role: picked.role, text: picked.text, at: picked.at ?? undefined }, picked.selection);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [conversationId, api, start]);

  return useMemo(
    () => (conversationId && api ? { conversationId, tasksFor, adding, start, setTitle, cancel, submit, api } : null),
    [conversationId, api, tasksFor, adding, start, setTitle, cancel, submit],
  );
}

/**
 * Tasks where useTasks does not run (the phone): the list for the chips, fetched again whenever the mod says Tasks
 * changed, and Add task's filing. A mod that refuses (one from before the phone could read Tasks) leaves no chips.
 */
export function useTaskList(
  desk: Pick<ReturnType<typeof useDesk>, "connection" | "tasksVersion" | "tasks">,
  capture?: (event: string, properties?: Record<string, unknown>) => void,
): TaskApi {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const { connection, tasksVersion } = desk;
  const deskRef = useRef(desk);
  useEffect(() => {
    deskRef.current = desk;
  });
  useEffect(() => {
    if (connection !== "open") return;
    let live = true;
    void deskRef.current.tasks.list(true).then((r) => live && r.ok && setTasks(r.tasks));
    return () => {
      live = false;
    };
  }, [connection, tasksVersion]);
  return useMemo<TaskApi>(
    () => ({
      tasks,
      create: async ({ source, ...t }) => {
        const r = await deskRef.current.tasks.create({ ...t, source });
        if (!r.ok) return r.message;
        capture?.("task_added", { origin: source.origin, desk: t.desk });
        setTasks((list) => [...(list ?? []).filter((x) => !r.tasks.some((n) => n.id === x.id)), ...r.tasks]);
        return null;
      },
    }),
    [tasks, capture],
  );
}

/** Messages register their text here as they draw, so ⌘⇧T can find the whole message behind a selection by its key. */
const drawnText = new Map<string, string>();

export function rememberMessage(conversationId: string, key: string, text: string): void {
  drawnText.set(`${conversationId}:${key}`, text);
  // A long session draws many threads: keep the newest few thousand.
  if (drawnText.size > 4000) drawnText.delete(drawnText.keys().next().value!);
}

/** The selection, when it sits inside one message of this conversation: that message and the selected words. */
function selectedMessage(conversationId: string): { role: "user" | "assistant"; text: string; at: string | null; selection: string } | null {
  const sel = document.getSelection();
  const selection = sel?.toString().trim();
  if (!sel || sel.isCollapsed || !selection) return null;
  const msgOf = (n: Node | null) => (n instanceof Element ? n : n?.parentElement)?.closest<HTMLElement>("[data-msg-key]") ?? null;
  const el = msgOf(sel.anchorNode);
  if (!el || el !== msgOf(sel.focusNode) || el.dataset.conversation !== conversationId) return null;
  const role = el.dataset.row;
  const key = el.dataset.msgKey!;
  const text = drawnText.get(`${conversationId}:${key}`);
  if ((role !== "user" && role !== "assistant") || !text) return null;
  return { role, text, at: el.dataset.msgAt ?? null, selection };
}

/**
 * The thread's side of "open the message" (revealMessage.ts): once this conversation's rows are in, mount the rows
 * above the window that hold the message, scroll it to the middle and mark it a moment. Rows still loading try again.
 */
export function useRevealMessage(
  scrollRef: RefObject<HTMLElement | null>,
  rows: TranscriptRow[] | undefined,
  reveal: (query: string) => void,
  unpin: () => void,
): void {
  const ctx = useMessageTasks();
  const ask = useRevealAsk(ctx?.conversationId ?? null);
  // The thread's handlers change every render; the frame below calls the latest. Reveal flushes the rows it mounts at
  // once, which React allows from a frame callback, not from an effect.
  const handlers = useRef({ reveal, unpin });
  useEffect(() => {
    handlers.current = { reveal, unpin };
  });
  const revealed = useRef(0);
  useEffect(() => {
    if (!ask || !rows?.length) return;
    const { key, quote, at, role } = ask.source;
    const frame = requestAnimationFrame(() => {
      // Find's way of mounting the rows above the window that hold a text: the quote's opening is in the message.
      if (quote && revealed.current !== ask.tick) {
        revealed.current = ask.tick;
        handlers.current.reveal(quote.replace(/…$/, "").slice(0, 40));
      }
      const root = scrollRef.current;
      const el =
        root?.querySelector<HTMLElement>(`[data-msg-key="${CSS.escape(key)}"]`) ??
        (at ? root?.querySelector<HTMLElement>(`[data-row="${role}"][data-msg-at="${CSS.escape(at)}"]`) : null);
      if (!el) return; // not loaded yet: the next rows try again, and a newer ask replaces this one
      handlers.current.unpin();
      el.scrollIntoView({ block: "center" });
      el.dataset.flash = "true";
      setTimeout(() => delete el.dataset.flash, 1600);
      takeReveal(ask.tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [ask, rows, scrollRef]);
}

/** A message's tasks and, when it is the one being added to, the editor; drawn under the message. */
export function MessageTaskArea({ row, ctx }: { row: TranscriptRow; ctx: MessageTasksValue }) {
  const tasks = ctx.tasksFor(row);
  const editing = ctx.adding && ctx.adding.role === row.role && ctx.adding.key === messageKey(row.role, row.text) ? ctx.adding : null;
  if (!tasks.length && !editing) return null;
  return (
    <div className="loki-msg-tasks">
      {tasks.map((t) => (
        <TaskChip key={t.id} task={t} api={ctx.api} />
      ))}
      {editing && <TaskEditor adding={editing} ctx={ctx} />}
    </div>
  );
}

/** The editor: the title, focused and selected; ⏎ files, esc cancels. */
function TaskEditor({ adding, ctx }: { adding: Adding; ctx: MessageTasksValue }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    el?.focus({ preventScroll: true });
    el?.select();
    el?.scrollIntoView({ block: "nearest" });
  }, [adding.origin, adding.text]);
  const file = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const err = await ctx.submit();
      if (err) setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="loki-msg-task-editor" role="group" aria-label="add a task from this message">
      <Field
        ref={ref}
        size="sm"
        type="search"
        name="message-task-title"
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        data-form-type="other"
        value={adding.title}
        onChange={(e) => ctx.setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void file();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            ctx.cancel();
          }
        }}
        placeholder="the task, in a line"
        aria-label="task title"
        aria-describedby={error ? "loki-msg-task-error" : undefined}
        // Room for a title before the buttons: on a narrow screen they wrap to the next line instead.
        style={{ flex: "1 1 220px", minWidth: 0 }}
      />
      <Button size="sm" tone="positive" kbd={formatKeys("enter")} onClick={() => void file()} disabled={!adding.title.trim() || busy}>
        {busy ? "adding…" : "add task"}
      </Button>
      <Button size="sm" kbd={formatKeys("escape")} onClick={ctx.cancel}>
        cancel
      </Button>
      <span className="loki-meta loki-msg-task-from">{adding.origin === "selection" ? "from the selected text" : "from this message"}</span>
      {error && (
        <span id="loki-msg-task-error" role="alert" className="loki-meta" style={{ color: "var(--loki-negative)" }}>
          {error}
        </span>
      )}
    </div>
  );
}

const CHIP_LABEL = { open: "task · open", waiting: "done? · waiting for you", done: "task · done" } as const;

/** A task on its message: its state, the agent's newest note while open, Confirm and Reopen while it waits for you. */
export function TaskChip({ task: t, api }: { task: Task; api: TaskApi }) {
  const state = chipState(t);
  const note = state === "open" ? t.metadata.lastNote : state === "waiting" && t.metadata.doneAsked !== "yes" ? t.metadata.doneAsked : null;
  const body = (
    <>
      <span className="loki-msg-task-mark" aria-hidden>
        {state === "done" ? "✓" : state === "waiting" ? "?" : "○"}
      </span>
      <span className="loki-msg-task-state">{CHIP_LABEL[state]}</span>
      <span className="loki-msg-task-title">{t.title}</span>
      {note && <span className="loki-msg-task-note">{note}</span>}
    </>
  );
  return (
    <div className="loki-msg-task" data-state={state}>
      {api.open ? (
        <button
          type="button"
          className="loki-msg-task-open"
          onClick={() => api.open!(t)}
          aria-label={`${CHIP_LABEL[state]}: ${t.title}${note ? ` — ${note}` : ""}. Open in Tasks`}
        >
          {body}
        </button>
      ) : (
        <span className="loki-msg-task-open">{body}</span>
      )}
      {state === "waiting" && api.confirm && api.reopen && (
        <span className="loki-msg-task-answer">
          <Button size="sm" tone="positive" onClick={() => api.confirm!(t)}>
            confirm
          </Button>
          <Button size="sm" tone="paper" onClick={() => api.reopen!(t)}>
            reopen
          </Button>
        </span>
      )}
    </div>
  );
}
