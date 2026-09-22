import { useEffect, useState } from "react";
import type { PermissionMode } from "./PermissionMode";
import type { ModelSelection } from "../../../core/models.ts";

/**
 * The switchers under the message box: model, its reasoning effort, and permission mode. Owns whether each is
 * open, the busy flags while changes are in flight, and the host ticks (⌘⇧M, ⌘⇧P) that open them.
 * Picking closes the popover first, then awaits the host.
 */
export function useModelAndMode({
  onLoadModels,
  onPickModel,
  onPickMode,
  modelPickerTick,
  modeMenuTick,
}: {
  onLoadModels?: () => void;
  onPickModel?: (selection: ModelSelection) => Promise<void>;
  onPickMode?: (mode: PermissionMode) => Promise<void>;
  modelPickerTick: number;
  modeMenuTick: number;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [changingEffort, setChangingEffort] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [changingMode, setChangingMode] = useState(false);
  // Effort applicability comes from list_models, so load it when a chat gains model controls instead
  // of requiring a first trip through the model picker before the separate effort control can appear.
  useEffect(() => {
    if (onPickModel) onLoadModels?.();
    // onPickModel is often a fresh scope-bound closure; the boolean capability is the stable trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!onPickModel]);
  useEffect(() => {
    if (modelPickerTick > 0 && onPickModel) {
      onLoadModels?.();
      setPickerOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelPickerTick]);
  useEffect(() => {
    if (modeMenuTick > 0 && onPickMode) setModeOpen(true);
  }, [modeMenuTick, onPickMode]);
  const pickMode = async (m: PermissionMode) => {
    if (!onPickMode) return;
    setModeOpen(false);
    setChangingMode(true);
    await onPickMode(m);
    setChangingMode(false);
  };
  const pickModel = async (selection: ModelSelection) => {
    if (!onPickModel) return;
    setPickerOpen(false);
    setSwitching(true);
    await onPickModel(selection);
    setSwitching(false);
  };
  const pickEffort = async (selection: ModelSelection) => {
    if (!onPickModel) return;
    setEffortOpen(false);
    setChangingEffort(true);
    await onPickModel(selection);
    setChangingEffort(false);
  };
  const togglePicker = () => {
    onLoadModels?.();
    setEffortOpen(false);
    setModeOpen(false);
    setPickerOpen((v) => !v);
  };
  const toggleEffort = () => {
    setPickerOpen(false);
    setModeOpen(false);
    setEffortOpen((v) => !v);
  };
  const toggleMode = () => {
    setPickerOpen(false);
    setEffortOpen(false);
    setModeOpen((v) => !v);
  };
  const closePicker = () => setPickerOpen(false);
  const closeEffort = () => setEffortOpen(false);
  const closeMode = () => setModeOpen(false);
  return { pickerOpen, switching, effortOpen, changingEffort, modeOpen, changingMode, pickMode, pickModel, pickEffort, togglePicker, toggleEffort, toggleMode, closePicker, closeEffort, closeMode };
}

export type ModelAndMode = ReturnType<typeof useModelAndMode>;
