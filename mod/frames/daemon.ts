import { fail, reply, type FrameHandlers } from "./context.ts";

/** What the restart frame handler needs from its host: restarting the daemon (plan 024), when it can. */
export interface DaemonDeps {
  daemon?: {
    restartDue: () => string | null;
    restart: (anyway: boolean) => Promise<string | null>;
  };
}

/** Restarting loki's daemon when the person asks (plan 024): refused while a chat works, unless `anyway`. */
export function daemonFrames({ daemon }: DaemonDeps): FrameHandlers {
  return {
    daemon_restart: async ({ anyway }) => {
      if (!daemon) return fail("this loki cannot restart itself: quit and open it again");
      const why = await daemon.restart(anyway);
      return why ? fail(why) : reply({});
    },
  };
}
