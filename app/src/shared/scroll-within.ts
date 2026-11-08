/** The geometry `scrollWithin` reads: an element's box on screen. */
type Placed = Pick<HTMLElement, "getBoundingClientRect">;

/** The geometry and offset `scrollWithin` reads and sets on the scrolling box. */
type ScrollBox = Placed & Pick<HTMLElement, "scrollTop" | "clientHeight" | "clientTop">;

/**
 * Scrolls `box` alone so that `el` sits at its middle or its end. `scrollIntoView` scrolls every box above as well,
 * the Inbox's own included, and pushed a tall card's header and controls off the top of the window.
 */
export function scrollWithin(box: ScrollBox, el: Placed, block: "center" | "end"): void {
  const at = el.getBoundingClientRect();
  const top = at.top - box.getBoundingClientRect().top - box.clientTop + box.scrollTop;
  box.scrollTop = Math.max(0, block === "end" ? top + at.height - box.clientHeight : top + at.height / 2 - box.clientHeight / 2);
}
