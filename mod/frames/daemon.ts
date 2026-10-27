import { fail, reply, type FrameHandlers } from "./context.ts";

/** What the update frame handler needs from its host: updating a checkout's loki (plans 024 and 041), when it can. */
export interface DaemonDeps {
  daemon?: {
    restartDue: () => string | null;
    restart: (anyway: boolean) => Promise<string | null>;
  };
}

/** Updating loki when the person asks (plans 024 and 041): the page built if due, then a restart, refused while a chat works unless `anyway`. */
export function daemonFrames({ daemon }: DaemonDeps): FrameHandlers {
  return {
    daemon_restart: async ({ anyway }) => {
      if (!daemon) return fail("this loki cannot restart itself: quit and open it again");
      const why = await daemon.restart(anyway);
      return why ? fail(why) : reply({});
    },
  };
}
