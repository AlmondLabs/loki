import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";

/** A registry with one tool that waits, for tests that interrupt a turn mid-call. It is not replay-safe. */
export function trialRegistry() {
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "trial",
      tools: [
        defineTool({
          name: "slow",
          description: "Wait for the given milliseconds.",
          parameters: Type.Object({ ms: Type.Number() }),
          execute: async (args) => {
            // The crash test kills its child here, once the call's intent is committed and the call is running.
            if (process.env.LOKI_CRASH_SIGNAL) process.stdout.write("under-way\n");
            await new Promise((resolve) => setTimeout(resolve, args.ms));
            return { content: [{ type: "text", text: "waited" }] };
          },
        }),
      ],
    }),
  );
  return registry;
}
