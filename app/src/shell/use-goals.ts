import { useCallback, useEffect, useRef, useState } from "react";
import { attentionGoalsCount, type GoalsSettings, type GoalsSnapshot } from "../../../core/goals.ts";
import type { InputOf } from "../../../core/frames.ts";
import type { Segment } from "./keymap";
import type { Workspace } from "./types";

export function useGoals(desk: Workspace, segment: Segment, notice: (m: string) => void) {
  const [snap, setSnap] = useState<GoalsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const goalsApi = useRef(desk.goals);
  useEffect(() => {
    goalsApi.current = desk.goals;
  });

  const refresh = useCallback(
    () =>
      desk.connection !== "open"
        ? Promise.resolve()
        : goalsApi.current.list().then((s) => {
            if (s) {
              setSnap(s);
              setError(null);
            } else {
              setError("goals did not answer");
            }
          }),
    [desk.connection],
  );

  useEffect(() => {
    if (desk.connection === "open") void refresh();
  }, [desk.goalsVersion, desk.connection, refresh]);

  useEffect(() => {
    if (segment !== "goals") return;
    void refresh();
    const t = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(t);
  }, [segment, refresh]);

  const apply = async (work: Promise<{ ok: true; snapshot: GoalsSnapshot } | { ok: false; message: string }>): Promise<boolean> => {
    const r = await work;
    if (!r.ok) {
      notice(r.message);
      return false;
    }
    setSnap(r.snapshot);
    setError(null);
    return true;
  };

  const create = (payload: InputOf<"goals_create">) => apply(desk.goals.create(payload));
  const update = (payload: InputOf<"goals_update">) => apply(desk.goals.update(payload));
  const remove = (id: string) => apply(desk.goals.remove(id));
  const addProgress = (id: string, note: string) => apply(desk.goals.addProgress(id, note));
  const toggleHabit = (id: string, day: string, done?: boolean) => apply(desk.goals.toggleHabit(id, day, done));
  const setSettings = (patch: Partial<GoalsSettings>) => apply(desk.goals.setSettings(patch));

  const runPulse = async (opts: { kind?: "daily" | "weekly" | "goal"; goal_id?: string } = {}) => {
    setRunning(true);
    const r = await desk.goals.runPulse(opts);
    setRunning(false);
    if (!r.ok) {
      notice(r.message);
      return null;
    }
    notice(r.note);
    void refresh();
    return r;
  };

  const startWork = async (id: string) => {
    const r = await desk.goals.startWork(id);
    if (!r.ok) {
      notice(r.message);
      return null;
    }
    void refresh();
    return r;
  };

  const startDiscover = async (agentId?: string | null) => {
    const r = await desk.goals.startDiscover(agentId);
    if (!r.ok) {
      notice(r.message);
      return null;
    }
    void refresh();
    return r;
  };

  const attentionCount = snap ? attentionGoalsCount(snap.goals) : 0;

  return {
    snap,
    error,
    running,
    attentionCount,
    refresh,
    create,
    update,
    remove,
    addProgress,
    toggleHabit,
    setSettings,
    runPulse,
    startWork,
    startDiscover,
  };
}

export type GoalsModel = ReturnType<typeof useGoals>;
