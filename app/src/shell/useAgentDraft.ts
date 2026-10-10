import { useState } from "react";
import type { NewAgentOptions } from "../../../core/attention/chat-client.ts";

export type CreateAgent = (opts: NewAgentOptions) => Promise<{ id: string } | { error: string }>;

/**
 * The first agent's form as the welcome sheet keeps it: name, description, persona and model, with
 * the busy flag and the last error, and `create`, which files the agent and hands its id to `onDone`. The
 * draft lives above the form so stepping back to the provider and forward again keeps what was typed.
 */
export function useAgentDraft(onCreate: CreateAgent, onDone: (agentId: string) => void) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [persona, setPersona] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await onCreate({ name: name.trim(), description: description.trim() || undefined, persona: persona.trim() || undefined, model: model.trim() || undefined });
      if ("error" in r) return setError(r.error);
      onDone(r.id);
    } finally {
      setBusy(false);
    }
  };
  return { name, setName, description, setDescription, persona, setPersona, model, setModel, busy, error, create };
}
