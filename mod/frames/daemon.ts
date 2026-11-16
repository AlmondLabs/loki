import { fail, reply, type FrameHandlers } from "./context.ts";

export interface DaemonDeps {
  daemon?: {
    restartDue: () => string | null;
    restart: (anyway: boolean) => Promise<string | null>;
  };
}

export function daemonFrames({ daemon }: DaemonDeps): FrameHandlers {
  return {
    daemon_restart: async ({ anyway }) => {
      if (!daemon) return fail("this loki cannot restart itself: quit and open it again");
      const why = await daemon.restart(anyway);
      return why ? fail(why) : reply({});
    },
  };
}
