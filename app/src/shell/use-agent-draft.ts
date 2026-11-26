import { useState } from "react";
import type { NewAgentOptions } from "../../../core/attention/chat-client.ts";

export type CreateAgent = (opts: NewAgentOptions) => Promise<{ id: string } | { error: string }>;

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
    const opts: NewAgentOptions = {
      name: name.trim(),
      description: description.trim() || undefined,
      persona: persona.trim() || undefined,
      model: model.trim() || undefined,
    };
    let r: Awaited<ReturnType<CreateAgent>>;
    try {
      r = await onCreate(opts);
    } catch (e) {
      setBusy(false);
      throw e;
    }
    setBusy(false);
    if ("error" in r) return setError(r.error);
    onDone(r.id);
  };
  return { name, setName, description, setDescription, persona, setPersona, model, setModel, busy, error, create };
}
