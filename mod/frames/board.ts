import type { TaskBoard } from "../tasks.ts";
import { fail, reply, type FrameContext, type FrameHandlers } from "./context.ts";

export interface BoardDeps {
  /** The board (mod/tasks.ts); absent until beads is ready. */
  tasks?: TaskBoard;
  /** The folder a conversation works in, for the task stamp. */
  folderFor?: (agentId: string | null, conversationId: string | null) => string | null;
}

/** The board: the tasks, filing one from the app, assigning, closing and moving them. Every change tells other tabs to refetch. */
export function boardFrames({ tasks: board, folderFor }: BoardDeps): FrameHandlers {
  if (!board) {
    const off = () => fail("the board is not available in this mod");
    return { tasks_list: off, task_create: off, task_assign: off, task_close: off, task_status: off };
  }
  const changed = (ctx: FrameContext) => ctx.broadcast({ type: "tasks_changed" });
  return {
    tasks_list: async ({ all }) => reply({ tasks: await board.list({ all }) }),
    task_create: async ({ title, description, labels, priority, desk, agentId, agentName, conversationId }, ctx) => {
      const task = await board.create({ title, description, labels, priority, stamp: { by: "you", agent: agentName, agentId, conversation: conversationId, desk, folder: folderFor?.(agentId, conversationId) ?? null } });
      changed(ctx);
      return reply({ task });
    },
    task_assign: async ({ ids, conversationId, desk, agentId, agentName, start }, ctx) => {
      const tasks = await board.assign(ids, { agent: agentName, agentId, conversation: conversationId, desk }, start ? "in_progress" : "open");
      changed(ctx);
      return reply({ tasks });
    },
    task_close: async ({ ids, reason }, ctx) => {
      const tasks = await board.close(ids, reason);
      changed(ctx);
      return reply({ tasks });
    },
    task_status: async ({ ids, status }, ctx) => {
      const tasks = await board.setStatus(ids, status);
      changed(ctx);
      return reply({ tasks });
    },
  };
}
