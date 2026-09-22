import { useState, type ReactNode } from "react";
import { PHONE_APPEARANCE, linkWord, moreSections, updateState, type LinkState } from "./model";
import type { Me } from "./Pair";
import { navigate } from "./router";
import { MenuRow, RowGroup } from "./rows";
import { ReloadSheet } from "./Settings";
import { currentBuild } from "./UpdateBar";
import { useTheme } from "../theme";
import { Scroll, TopBar } from "./ui";

/**
 * More, Slack's You sheet with loki's content: this phone's profile and the paired Mac's presence first,
 * then named rows for the places (Agents, Learn, the archive, Preferences) and the utilities (Updates,
 * About, the connection) — model.ts moreSections decides the rows and their asides. Every row opens a page,
 * except Updates, whose reload is confirmed in a sheet here. Rows carry `data-launch`, so focus comes back
 * to the one you left from, and the scroll comes back from the scroll memory.
 */
export function More({ me, link, agents, running, due, archived, servedBuild, banner }: { me: Me; link: LinkState; agents: number; running: number; due: number; archived: number; servedBuild: string | null; banner?: ReactNode }) {
  const theme = useTheme();
  const [reload, setReload] = useState(false);
  const update = updateState(servedBuild, currentBuild());
  const appearance = PHONE_APPEARANCE.find((a) => a.value === theme.preference)?.label ?? "System";
  const sections = moreSections({ link, agents, running, due, archived, appearance, update });
  return (
    <div className="loki-phone-page">
      <TopBar title="More" />
      {banner}
      <Scroll memory="more" flush>
        <section className="loki-phone-me" aria-label="This phone">
          <span className="loki-phone-avatar">
            <span aria-hidden className="loki-phone-me-face">
              {(me.name || "?").slice(0, 1).toUpperCase()}
            </span>
            <span aria-hidden className="loki-phone-presence" data-link={link} data-on={link === "online"} />
          </span>
          <div className="loki-phone-me-copy">
            <div className="loki-phone-me-name">{me.name}</div>
            <div className="loki-phone-me-line">Paired with the Mac · {linkWord(link)}</div>
          </div>
        </section>
        <div className="loki-phone-groups">
          {sections.map((g) => (
            <RowGroup key={g.label}>
              {g.rows.map((r) =>
                r.to ? (
                  <MenuRow key={r.id} icon={r.icon} label={r.label} aside={r.aside} page launch={`more:${r.id}`} onClick={() => r.to && navigate(r.to)} />
                ) : (
                  <MenuRow key={r.id} icon={r.icon} label={r.label} aside={r.aside} sheet launch={`more:${r.id}`} onClick={() => setReload(true)} />
                ),
              )}
            </RowGroup>
          ))}
        </div>
      </Scroll>
      {reload && <ReloadSheet state={update} onClose={() => setReload(false)} />}
    </div>
  );
}
