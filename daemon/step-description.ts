import type { ToolRegistration } from "@earendil-works/pi-durable";
import { isRecord } from "./tool-kinds.ts";

const DESCRIPTION_PROPERTY = {
  type: "string",
  description: 'A few words saying what this call does, shown to the person as the title of this step, such as "Run the CRM tests".',
};

const stringsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

function withDescriptionArgument(args: unknown): unknown {
  return isRecord(args) && typeof args.description !== "string" ? { ...args, description: "" } : args;
}

function withoutDescriptionArgument(args: unknown): unknown {
  if (!isRecord(args)) return args;
  const { description, ...rest } = args;
  return rest;
}

/**
 * The tool's arguments gain `description`: a few words on what the call does, which titles its step. The model is
 * told it is required, but a call without one is given `""` and runs. With `drop`, the tool never receives it.
 */
export function withStepDescription(tool: ToolRegistration, { drop = false }: { drop?: boolean } = {}): ToolRegistration {
  const schema: unknown = tool.parameters;
  const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
  const required = isRecord(schema) ? stringsOf(schema.required) : [];
  const prepare = (args: unknown): unknown => (tool.prepareArguments ? tool.prepareArguments(args) : args);
  const described: ToolRegistration = {
    ...tool,
    parameters: {
      ...(isRecord(schema) ? schema : {}),
      properties: { description: DESCRIPTION_PROPERTY, ...properties },
      required: ["description", ...required],
    },
    prepareArguments: (args) => withDescriptionArgument(prepare(args)),
  };
  return drop ? { ...described, execute: (args, api, context) => tool.execute(withoutDescriptionArgument(args), api, context) } : described;
}
