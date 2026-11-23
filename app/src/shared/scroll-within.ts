type Placed = Pick<HTMLElement, "getBoundingClientRect">;

type ScrollBox = Placed & Pick<HTMLElement, "scrollTop" | "clientHeight" | "clientTop">;

// Outside (HTML): `scrollIntoView` scrolls every box above as well, the Inbox's own included, which pushed a tall card's
// header off the top of the window; this scrolls `box` alone.
export function scrollWithin(box: ScrollBox, el: Placed, block: "center" | "end"): void {
  const at = el.getBoundingClientRect();
  const top = at.top - box.getBoundingClientRect().top - box.clientTop + box.scrollTop;
  box.scrollTop = Math.max(0, block === "end" ? top + at.height - box.clientHeight : top + at.height / 2 - box.clientHeight / 2);
}
