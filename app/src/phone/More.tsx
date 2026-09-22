import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import type { Me } from "./Pair";
import { navigate, type Route } from "./router";
import { GUTTER, Scroll, TopBar } from "./ui";

/**
 * More: the utility hub behind the fourth tab — Learn, the archived desks, preferences and the
 * connection. For now a list of named rows, each opening its page; U6 recomposes it around the
 * profile and the paired Mac. The rows carry `data-launch` so focus comes back to the one you left from.
 */
export function More({ me, due, archived, banner }: { me: Me; due: number; archived: number; banner?: ReactNode }) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <TopBar title="More" sub={<span>{me.name} · paired</span>} />
      {banner}
      <Scroll memory="more" style={{ padding: `4px ${GUTTER.right} 24px ${GUTTER.left}` }}>
        <ul aria-label="more" className="loki-phone-list">
          <MenuRow icon="learn" label="Learn" aside={due > 0 ? `${due} due` : null} to={{ kind: "learn" }} />
          <MenuRow icon="archive" label="Archived desks" aside={archived > 0 ? String(archived) : null} to={{ kind: "archive" }} />
          <MenuRow icon="settings" label="Preferences" aside={null} to={{ kind: "preferences" }} />
        </ul>
      </Scroll>
    </div>
  );
}

/** One row: an icon, the name, a quiet aside, a chevron; the whole row opens `to`. */
function MenuRow({ icon, label, aside, to }: { icon: IconName; label: string; aside: string | null; to: Route }) {
  return (
    <li>
      <button type="button" className="loki-phone-menu-row" data-launch={`more:${to.kind}`} onClick={() => navigate(to)}>
        <Icon name={icon} size={22} />
        <span className="loki-phone-menu-row-label">{label}</span>
        {aside && <span className="loki-phone-menu-row-aside">{aside}</span>}
        <Icon name="chevron-right" size={18} />
      </button>
    </li>
  );
}
