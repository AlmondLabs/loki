import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** The shell's two slots for the showing place: its list column, and the room for the detail inside `<main>`. */
export interface PlaceSlots {
  list: HTMLElement | null;
  detail: HTMLElement | null;
}

const PlaceSlotsContext = createContext<PlaceSlots>({ list: null, detail: null });

/** The shell hands the showing place its two slots (plan 2026-11-14-1330, KTD1), once each element has mounted. */
export function PlaceSlotsProvider({ slots, children }: { slots: PlaceSlots; children: ReactNode }) {
  return <PlaceSlotsContext value={slots}>{children}</PlaceSlotsContext>;
}

/**
 * A place's list and its detail, drawn by the place's one owner component so both columns read one state (KTD1):
 * the list goes between the sidebar and `<main>`, the detail inside `<main>`, and nothing draws until the shell's
 * slots exist.
 */
export function PlaceColumns({ list, detail }: { list: ReactNode; detail: ReactNode }) {
  const slots = useContext(PlaceSlotsContext);
  return (
    <>
      {slots.list && createPortal(list, slots.list)}
      {slots.detail && createPortal(detail, slots.detail)}
    </>
  );
}
