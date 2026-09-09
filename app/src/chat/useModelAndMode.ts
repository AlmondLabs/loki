import { useEffect, useState } from "react";
import type { PermissionMode } from "./PermissionMode";

/**
 * The two switchers under the message box: the model picker and the permission-mode menu. Owns whether each is
 * open, the busy flag while a change is in flight, and the host ticks (⌘⇧M, ⌘⇧P) that open them.
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
  onPickModel?: (handle: string) => Promise<void>;
  onPickMode?: (mode: PermissionMode) => Promise<void>;
  modelPickerTick: number;
  modeMenuTick: number;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    if (modelPickerTick > 0 && onPickModel) {
      onLoadModels?.();
      setPickerOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelPickerTick]);
  const [modeOpen, setModeOpen] = useState(false);
  const [changingMode, setChangingMode] = useState(false);
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
  const pickModel = async (handle: string) => {
    if (!onPickModel) return;
    setPickerOpen(false);
    setSwitching(true);
    await onPickModel(handle);
    setSwitching(false);
  };
  const togglePicker = () => {
    onLoadModels?.();
    setPickerOpen((v) => !v);
  };
  const toggleMode = () => setModeOpen((v) => !v);
  const closePicker = () => setPickerOpen(false);
  const closeMode = () => setModeOpen(false);
  return { pickerOpen, switching, modeOpen, changingMode, pickMode, pickModel, togglePicker, toggleMode, closePicker, closeMode };
}

export type ModelAndMode = ReturnType<typeof useModelAndMode>;
