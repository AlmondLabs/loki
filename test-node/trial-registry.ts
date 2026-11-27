import { Type } from "typebox";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";

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
            if (process.env.LOKI_CRASH_SIGNAL) process.stdout.write("under-way\n");
            await new Promise((resolve) => setTimeout(resolve, args.ms));
            return { output: [{ type: "text", text: "waited" }] };
          },
        }),
      ],
    }),
  );
  return registry;
}
