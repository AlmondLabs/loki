import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { dispatchMessage, isWaiting } from "../tasks/model";

import type { Segment } from "./keymap";
import type { CatchUp, Desk } from "./types";
import type { DeskSummary, Task } from "../../../core/frame-types.ts";
import type { TaskApi } from "../tasks/message-tasks";

/** A desk the task list can hand tasks to: the picker's row, or the desk just created for them. */
export type AssignTarget = Pick<DeskSummary, "scope" | "agentId" | "conversationId" | "title"> & { agentName: string | null };

/**
 * The task list as the window sees it: the task list with its loading and error flags, and the moves — assign
 * or dispatch to a desk, close (or confirm an agent's done?), reopen, set a status, file a new one. Refreshes when the mod says the task list
 * changed, when the segment opens, and slowly while it shows (Dolt has no file to watch). Every move
 * reports through `notice` and refreshes the list afterwards.
 */
export function useTasks(
  desk: Desk,
  segment: Segment,
  notice: (m: string) => void,
  link: { send: CatchUp["send"]; openDesk: (agentId: string, conversationId: string, opts?: { chat?: boolean }) => void },
  capture?: (event: string, properties?: Record<string, unknown>) => void,
) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Reads in flight, outside React state: a refresh that an effect starts can say so without setting state in the effect.
  const [inFlight] = useState(createCounter);
  const loading = useSyncExternalStore(inFlight.subscribe, inFlight.get) > 0;
  // `refresh` changes with the link only; desk.tasks is a fresh object every render.
  const tasksApi = useRef(desk.tasks);
  useEffect(() => {
    tasksApi.current = desk.tasks;
  });
  const refresh = useCallback((): Promise<void> => {
    if (desk.connection !== "open") return Promise.resolve();
    inFlight.start();
    return tasksApi.current
      .list(true)
      .then((r) => {
        if (r.ok) {
          setTasks(r.tasks);
          setError(null);
        } else setError(r.message);
      })
      .finally(inFlight.end);
  }, [desk.connection, inFlight]);
  useEffect(() => {
    if (desk.connection === "open") void refresh();
  }, [desk.tasksVersion, desk.connection, refresh]);
  useEffect(() => {
    if (segment !== "tasks") return;
    void refresh();
    const t = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(t);
  }, [segment, refresh]);
  const openTasks = tasks?.filter((t) => t.status !== "closed").length ?? 0;

  /**
   * Assign: the tasks get the agent as assignee and the conversation in their metadata; the agent hears
   * about them on the user's next message there. Dispatch: assign, then post the tasks so the agent starts now.
   */
  const assignTo = async (target: AssignTarget, ids: string[], start: boolean) => {
    if (!target.conversationId) return notice("that chat has no conversation to assign to");
    const r = await desk.tasks.assign(
      ids,
      { agentId: target.agentId, agentName: target.agentName, conversationId: target.conversationId, desk: target.scope },
      start,
    );
    if (!r.ok) return notice(r.message);
    const assigned = r.tasks.length ? r.tasks : (tasks ?? []).filter((t) => ids.includes(t.id));
    if (start && target.agentId) {
      const rt = { agent_id: target.agentId, conversation_id: target.conversationId };
      link.send(rt, dispatchMessage(assigned), [], { desk: target.title });
      link.openDesk(target.agentId, target.conversationId, { chat: true });
    } else {
      notice(
        `${ids.length === 1 ? "task" : `${ids.length} tasks`} assigned to ${target.title ?? target.scope}${target.agentName ? ` · ${target.agentName} hears about it on your next message there` : ""}`,
      );
    }
    void refresh();
  };
  /** The tasks an agent said were done, among these: closing them is your confirmation, reopening them your no. */
  const waitingAmong = (ids: string[]) => (tasks ?? []).filter((t) => ids.includes(t.id) && isWaiting(t)).length;
  const closeTasks = async (ids: string[]) => {
    const confirmed = waitingAmong(ids);
    const r = await desk.tasks.close(ids, confirmed === ids.length ? "confirmed done in Tasks" : "done in Tasks");
    if (!r.ok) notice(r.message);
    else for (let i = 0; i < confirmed; i++) capture?.("task_confirmed", { action: "confirm" });
    void refresh();
  };
  const reopenTasks = async (ids: string[]) => {
    const waiting = waitingAmong(ids);
    const r = await desk.tasks.reopen(ids);
    if (!r.ok) notice(r.message);
    else {
      for (let i = 0; i < waiting; i++) capture?.("task_confirmed", { action: "reopen" });
      notice(`${ids.length === 1 ? "task" : `${ids.length} tasks`} reopened`);
    }
    void refresh();
  };
  const setTaskStatus = async (ids: string[], status: "open" | "blocked") => {
    const r = await desk.tasks.setStatus(ids, status);
    if (!r.ok) notice(r.message);
    void refresh();
  };
  const createTask = async (t: { title: string; description?: string; labels?: string[]; priority: number }): Promise<string | null> => {
    const r = await desk.tasks.create({ ...t, desk: desk.scope, agentId: desk.agentId, agentName: desk.agentName, conversationId: desk.conversationId });
    if (!r.ok) return r.message;
    notice(`filed ${r.tasks[0]?.id ?? "the task"}`);
    void refresh();
    return null;
  };
  /** Add task from a chat message (tasks/message-tasks.tsx): filed as yours, stamped with the message it came from. */
  const addFromMessage: TaskApi["create"] = async ({ source, ...t }) => {
    const r = await desk.tasks.create({ ...t, source });
    if (!r.ok) return r.message;
    capture?.("task_added", { origin: source.origin, desk: t.desk });
    notice(`filed ${r.tasks[0]?.id ?? "the task"} · in Tasks › Mine until you assign it`);
    void refresh();
    return null;
  };
  return { list: tasks, loading, error, refresh, openTasks, assignTo, closeTasks, reopenTasks, setTaskStatus, createTask, addFromMessage };
}

/** A count that components read with useSyncExternalStore: how many of something are under way. */
function createCounter() {
  let n = 0;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of listeners) l();
  };
  return {
    get: () => n,
    start: () => {
      n += 1;
      emit();
    },
    end: () => {
      n -= 1;
      emit();
    },
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}
