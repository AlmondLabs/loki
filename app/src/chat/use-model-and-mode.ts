import { useEffect, useEffectEvent, useState } from "react";
import type { ModelSelection } from "../../../core/models.ts";

export function useModelAndMode({
  onLoadModels,
  onPickModel,
  onPickMode,
  modelPickerTick,
  modeMenuTick,
}: {
  onLoadModels?: () => void;
  onPickModel?: (selection: ModelSelection) => Promise<void>;
  onPickMode?: (mode: string) => Promise<void>;
  modelPickerTick: number;
  modeMenuTick: number;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [changingMode, setChangingMode] = useState(false);
  const canPickModel = !!onPickModel;
  useEffect(() => {
    if (canPickModel) onLoadModels?.();
  }, [canPickModel, onLoadModels]);
  const [seenPickerTick, setSeenPickerTick] = useState(0);
  if (modelPickerTick !== seenPickerTick) {
    setSeenPickerTick(modelPickerTick);
    if (modelPickerTick > 0 && onPickModel) setPickerOpen(true);
  }
  const loadForPicker = useEffectEvent(() => {
    if (onPickModel) onLoadModels?.();
  });
  useEffect(() => {
    if (modelPickerTick > 0) loadForPicker();
  }, [modelPickerTick]);
  const [seenModeTick, setSeenModeTick] = useState(0);
  if (modeMenuTick !== seenModeTick) {
    setSeenModeTick(modeMenuTick);
    if (modeMenuTick > 0 && onPickMode) setModeOpen(true);
  }
  const pickMode = async (m: string) => {
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
