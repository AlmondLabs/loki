import { fail, reply, type FrameHandlers } from "./context.ts";

export type RestartAnswer = { code: "not_updated"; reason: string } | { code: "updated" } | { code: "restart"; restart: () => void };

export interface DaemonDeps {
  daemon?: {
    restartDue: () => string | null;
    restart: (anyway: boolean) => Promise<RestartAnswer>;
  };
}

export function daemonFrames({ daemon }: DaemonDeps): FrameHandlers {
  return {
    daemon_restart: async ({ anyway }) => {
      if (!daemon) return fail("this loki cannot restart itself: quit and open it again");
      const answer = await daemon.restart(anyway);
      if (answer.code === "not_updated") return fail(answer.reason);
      return answer.code === "restart" ? { ok: true, reply: {}, afterReply: answer.restart } : reply({});
    },
  };
}
