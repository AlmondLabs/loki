import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface PlaceSlots {
  list: HTMLElement | null;
  detail: HTMLElement | null;
}

const PlaceSlotsContext = createContext<PlaceSlots>({ list: null, detail: null });

export function PlaceSlotsProvider({ slots, children }: { slots: PlaceSlots; children: ReactNode }) {
  const value = useMemo(() => ({ list: slots.list, detail: slots.detail }), [slots.list, slots.detail]);
  return <PlaceSlotsContext value={value}>{children}</PlaceSlotsContext>;
}

export function PlaceColumns({ list, detail }: { list: ReactNode; detail: ReactNode }) {
  const slots = useContext(PlaceSlotsContext);
  return (
    <>
      {slots.list && createPortal(list, slots.list)}
      {slots.detail && createPortal(detail, slots.detail)}
    </>
  );
}
