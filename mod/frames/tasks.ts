import type { TaskStore } from "../tasks.ts";
import { fail, reply, type FrameContext, type FrameHandlers } from "./context.ts";

export interface TaskDeps {
  /** The task list (mod/tasks.ts); absent until beads is ready. */
  tasks?: TaskStore;
  /** The folder a conversation works in, for the task stamp. */
  folderFor?: (agentId: string | null, conversationId: string | null) => string | null;
}

/** Tasks: the list, filing one from the app, assigning, closing, reopening and moving them. Every change tells other tabs to refetch. */
export function taskFrames({ tasks: store, folderFor }: TaskDeps): FrameHandlers {
  if (!store) {
    const off = () => fail("Tasks is not available in this mod");
    return { tasks_list: off, task_create: off, task_assign: off, task_close: off, task_reopen: off, task_status: off };
  }
  const changed = (ctx: FrameContext) => ctx.broadcast({ type: "tasks_changed" });
  return {
    tasks_list: async ({ all }) => reply({ tasks: await store.list({ all }) }),
    task_create: async ({ title, description, labels, priority, desk, agentId, agentName, conversationId }, ctx) => {
      const task = await store.create({ title, description, labels, priority, stamp: { by: "you", agent: agentName, agentId, conversation: conversationId, desk, folder: folderFor?.(agentId, conversationId) ?? null } });
      changed(ctx);
      return reply({ task });
    },
    task_assign: async ({ ids, conversationId, desk, agentId, agentName, start }, ctx) => {
      const tasks = await store.assign(ids, { agent: agentName, agentId, conversation: conversationId, desk }, start ? "in_progress" : "open");
      changed(ctx);
      return reply({ tasks });
    },
    task_close: async ({ ids, reason }, ctx) => {
      // The person closing (or confirming an agent's done?) from Tasks: theirs to decide, whoever has the task.
      const tasks = await store.close(ids, reason, { force: true });
      changed(ctx);
      return reply({ tasks });
    },
    task_reopen: async ({ ids }, ctx) => {
      const tasks = await store.reopen(ids);
      changed(ctx);
      return reply({ tasks });
    },
    task_status: async ({ ids, status }, ctx) => {
      const tasks = await store.setStatus(ids, status);
      changed(ctx);
      return reply({ tasks });
    },
  };
}
