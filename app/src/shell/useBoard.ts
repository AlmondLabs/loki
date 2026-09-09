import { useCallback, useEffect, useState } from "react";
import { dispatchMessage, type Task } from "../board/model";
import type { DeskSummary } from "../desk/useDesk";
import type { Segment } from "./keymap";
import type { CatchUp, Desk } from "./types";

/** A desk the board can hand tasks to: the picker's row, or the desk just created for them. */
export type AssignTarget = Pick<DeskSummary, "scope" | "agentId" | "conversationId" | "title"> & { agentName: string | null };

/**
 * The board as the window sees it: the task list with its loading and error flags, and the moves — assign
 * or dispatch to a desk, close, set a status, file a new one. Refreshes when the mod says the board
 * changed, when the segment opens, and slowly while it shows (Dolt has no file to watch). Every move
 * reports through `notice` and refreshes the list afterwards.
 */
export function useBoard(desk: Desk, segment: Segment, notice: (m: string) => void, link: { send: CatchUp["send"]; openDesk: (agentId: string, conversationId: string, opts?: { chat?: boolean }) => void }) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (desk.connection !== "open") return;
    setLoading(true);
    try {
      const r = await desk.board.list(true);
      if (r.ok) {
        setTasks(r.tasks);
        setError(null);
      } else setError(r.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desk.connection]);
  useEffect(() => {
    if (desk.connection === "open") void refresh();
  }, [desk.tasksVersion, desk.connection, refresh]);
  useEffect(() => {
    if (segment !== "board") return;
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
    if (!target.conversationId) return notice("that desk has no conversation to assign to");
    const r = await desk.board.assign(ids, { agentId: target.agentId, agentName: target.agentName, conversationId: target.conversationId, desk: target.scope }, start);
    if (!r.ok) return notice(r.message);
    const assigned = r.tasks.length ? r.tasks : (tasks ?? []).filter((t) => ids.includes(t.id));
    if (start && target.agentId) {
      const rt = { agent_id: target.agentId, conversation_id: target.conversationId };
      link.send(rt, dispatchMessage(assigned), [], { desk: target.title });
      link.openDesk(target.agentId, target.conversationId, { chat: true });
    } else {
      notice(`${ids.length === 1 ? "task" : `${ids.length} tasks`} assigned to ${target.title ?? target.scope}${target.agentName ? ` · ${target.agentName} hears about it on your next message there` : ""}`);
    }
    void refresh();
  };
  const closeTasks = async (ids: string[]) => {
    const r = await desk.board.close(ids, "done from the board");
    if (!r.ok) notice(r.message);
    void refresh();
  };
  const setTaskStatus = async (ids: string[], status: "open" | "blocked") => {
    const r = await desk.board.setStatus(ids, status);
    if (!r.ok) notice(r.message);
    void refresh();
  };
  const createTask = async (t: { title: string; description?: string; labels?: string[]; priority: number }): Promise<string | null> => {
    const r = await desk.board.create({ ...t, desk: desk.scope, agentId: desk.agentId, agentName: desk.agentName, conversationId: desk.conversationId });
    if (!r.ok) return r.message;
    notice(`filed ${r.tasks[0]?.id ?? "the task"}`);
    void refresh();
    return null;
  };
  return { tasks, loading, error, refresh, openTasks, assignTo, closeTasks, setTaskStatus, createTask };
}
