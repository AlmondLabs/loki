import { useEffect, useState } from "react";
import type { PermissionMode } from "./PermissionMode";
import type { ModelSelection } from "../../../core/models.ts";

/**
 * The conversation's switchers: Select model (the pill in the box; its effort is chosen inside it) and the
 * permission mode under the box. Owns whether each is open, the busy flags while changes are in flight, and
 * the host ticks (⌘⇧M, ⌘⇧P) that open them. Picking closes the picker first, then awaits the host.
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
  const [modeOpen, setModeOpen] = useState(false);
  const [changingMode, setChangingMode] = useState(false);
  // The pill's name and effort come from list_models, so load it when a chat gains model controls instead
  // of waiting for a first trip through the picker — and again when the host's loader changes (a new harness
  // link: an ask made before the link was up came back empty).
  useEffect(() => {
    if (onPickModel) onLoadModels?.();
    // onPickModel is often a fresh scope-bound closure; the boolean capability is the stable trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!onPickModel, onLoadModels]);
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
  const togglePicker = () => {
    onLoadModels?.();
    setModeOpen(false);
    setPickerOpen((v) => !v);
  };
  const toggleMode = () => {
    setPickerOpen(false);
    setModeOpen((v) => !v);
  };
  const closePicker = () => setPickerOpen(false);
  const closeMode = () => setModeOpen(false);
  return { pickerOpen, switching, modeOpen, changingMode, pickMode, pickModel, togglePicker, toggleMode, closePicker, closeMode };
}

export type ModelAndMode = ReturnType<typeof useModelAndMode>;
