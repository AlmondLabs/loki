import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ListIcon, Sheet } from "../components";
import { AgentFace } from "../desk/agent-chip";
import { Icon } from "../shared/icons";
import { cleanQuery } from "../shared/search";
import { COVERAGE, buildIndex, flatHits, recentPlaceHits, recentPlaces, search, type SearchHit, type SearchSources } from "./search-model";
import { formatKeys } from "./keymap";
import type { CommandScope, SharedMode, SharedModels, SharedModes } from "./command-center";
import {
  ModelRow,
  ModelSwitchFoot,
  ModelSwitchList,
  modelOptionId,
  switcherGroups,
  useModelSwitch,
  type SwitchRow,
  type SwitchSource,
} from "../chat/model-switcher";
import { preferredModelEntry } from "../chat/model-picker";
import { selectionOf, type ReasoningEffort } from "../../../core/models.ts";
import "./search-sheet.css";

const LIST_ID = "loki-search-results";
const optionId = (key: string) => `loki-search-opt-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

/** A command plain ⌘K offers: a menu-bar action that works on this screen now, and its key (commandsFor). */
export interface CommandHit {
  id: string;
  label: string;
  keys: string | null;
}

/** One row of plain ⌘K, whatever it is: a search hit, a command to run, or a model to switch to. */
type Row =
  { kind: "hit"; hit: SearchHit } | { kind: "command"; command: CommandHit } | { kind: "model"; model: SwitchRow } | { kind: "mode"; mode: SharedMode };
const rowKey = (r: Row) =>
  r.kind === "hit" ? r.hit.key : r.kind === "command" ? `command:${r.command.id}` : r.kind === "model" ? `model:${r.model.key}` : `mode:${r.mode.id}`;

/** How many commands and models plain ⌘K shows for a query: the Models scope holds the rest. */
const COMMANDS_MAX = 5;
const MODELS_MAX = 3;
/** Typed at the start of plain ⌘K, this steps into the Models scope. */
const MODELS_PREFIX = /^models?\s$/i;
/** Typed at the start of plain ⌘K, this steps into the Permissions scope. */
const PERMISSIONS_PREFIX = /^(permissions?|modes?)\s$/i;

/**
 * The chat's permission modes for what is typed (plan 2026-11-12-1505, U21). In the Permissions scope: all of them, or
 * those whose name or line holds each word. In plain ⌘K: only once something is typed, the ones it names, or all of
 * them for "permission" or "mode". A typed word matches the start of a word, as a name is typed.
 */
export function matchModes(modes: SharedModes | null | undefined, typed: string, inScope: boolean): SharedMode[] {
  if (!modes) return [];
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return inScope ? [...modes.list] : [];
  // Each word must start a word of the mode's name or line: "strict" is not inside "Unrestricted".
  const named = modes.list.filter((m) => {
    const said = `${m.label} ${m.description}`.toLowerCase().split(/[^a-z0-9]+/);
    return words.every((w) => said.some((x) => x.startsWith(w)));
  });
  if (named.length > 0 || inScope) return named;
  return words.every((w) => "permission mode".includes(w)) && typed.length >= 3 ? [...modes.list] : [];
}

/** The commands whose label holds every word of the query, at most COMMANDS_MAX; none before anything is typed. */
export function matchCommands(commands: readonly CommandHit[], typed: string): CommandHit[] {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return commands.filter((c) => words.every((w) => c.label.toLowerCase().includes(w))).slice(0, COMMANDS_MAX);
}

/** The open chat's best model matches for plain ⌘K: at most MODELS_MAX, none before anything is typed or with no chat. */
export function matchModels(models: SharedModels | null, typed: string): SwitchRow[] {
  if (!models?.entries || !typed) return [];
  return switcherGroups(models.entries, models.current, models.started, typed)
    .flatMap((g) => g.rows)
    .filter((r) => !r.off)
    .slice(0, MODELS_MAX);
}

const EMPTY_SOURCE: SwitchSource = { entries: null, current: null, currentEffort: null, started: false, usual: [], pick: () => {} };

/**
 * ⌘K, loki's one command panel (plan 013 U9; plan 2026-11-12-1505 U23): a panel near the top of the window, floating
 * with nothing dimmed, the field focused at once. Plain, it finds chats, agents, labels, waiting items and pages
 * (before typing, the recent places), runs this screen's commands, and offers the open chat's best model matches. The
 * Models scope (a chip in the field: the model pill or ⌘⇧M open on it; Tab on a model, or "model ", steps in;
 * Backspace on the empty field steps out) is the model switcher: Usual first, the chat's harness, effort at the foot.
 * ↑↓ move the highlight (focus stays in the field: a combobox over one listbox), Enter takes it, Esc and ⌘K close.
 */
export function SearchSheet({
  sources,
  here,
  avatar,
  onOpen,
  onClose,
  scope = "all",
  onScope = () => {},
  models = null,
  commands = [],
  onCommand = () => {},
}: {
  sources: SearchSources;
  /** The place showing (a recent-places key), left out of the recents. */ here: string | null;
  avatar: (agentId: string) => string | null;
  onOpen: (hit: SearchHit) => void;
  onClose: () => void;
  scope?: CommandScope;
  onScope?: (scope: CommandScope) => void;
  /** The open chat's model controls (command-center.ts); null with no chat open. */
  models?: SharedModels | null;
  /** This screen's commands (commandsFor). */
  commands?: readonly CommandHit[];
  onCommand?: (id: string) => void;
}) {
  // No autoFocus on the field: Sheet notes the element focused before it (to hand focus back on close), then focuses the field, its first control.
  const [query, setQuery] = useState("");
  const [placeKeys, setPlaceKeys] = useState(() => recentPlaces.read());
  const modes = models?.modes ?? null;
  // The Permissions scope opens with the chat's own mode highlighted, as a Mac pop-up opens on its current item.
  const currentModeAt = Math.max(0, modes?.list.findIndex((m) => m.id === modes.current) ?? 0);
  const [active, setActive] = useState(() => (scope === "permissions" ? currentModeAt : 0));
  const scroller = useRef<HTMLDivElement>(null);
  const inModels = scope === "models";
  const inModes = scope === "permissions";
  const scoped = inModels || inModes;

  const typed = cleanQuery(query);
  const index = useMemo(() => buildIndex(sources), [sources]);
  const groups = useMemo(() => search(index, typed), [index, typed]);
  const places = useMemo(
    () =>
      typed
        ? []
        : recentPlaceHits(
            placeKeys.filter((k) => k !== here),
            sources,
          ),
    [typed, placeKeys, here, sources],
  );
  const commandHits = matchCommands(commands, typed);
  const modelHits = matchModels(models, typed);
  const modeHits = matchModes(modes, typed, inModes);
  // In the Permissions scope the list is the modes alone; plain ⌘K ends with the ones typed for.
  const rows: Row[] = inModes
    ? modeHits.map((mode): Row => ({ kind: "mode", mode }))
    : [
        ...(typed ? flatHits(groups) : places).map((hit): Row => ({ kind: "hit", hit })),
        ...commandHits.map((command): Row => ({ kind: "command", command })),
        ...modelHits.map((model): Row => ({ kind: "model", model })),
        ...modeHits.map((mode): Row => ({ kind: "mode", mode })),
      ];
  const found = inModes ? modeHits.length : groups.reduce((n, g) => n + g.total, 0) + commandHits.length + modelHits.length + modeHits.length;
  const at = Math.min(active, rows.length - 1);
  const current = at >= 0 ? rows[at] : null;
  const sw = useModelSwitch(models ?? EMPTY_SOURCE, inModels ? typed : "");

  // A new query starts at the top result (the highlight resets as it is typed, below).
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [typed, scope]);
  useEffect(() => {
    if (current && !inModels) document.getElementById(optionId(rowKey(current)))?.scrollIntoView({ block: "nearest" });
  }, [current, inModels]);

  const open = (hit: SearchHit) => {
    recentPlaces.add(hit.place);
    onOpen(hit);
  };
  const pickModel = (row: SwitchRow, effort?: ReasoningEffort | null) => {
    if (!models) return;
    sw.pick(row, effort);
    onClose();
  };
  const take = (r: Row) => {
    if (r.kind === "hit") {
      open(r.hit);
    } else if (r.kind === "command") {
      onClose();
      onCommand(r.command.id);
    } else if (r.kind === "mode") {
      modes?.pick(r.mode.id);
      onClose();
    } else if (models) {
      models.pick(selectionOf(preferredModelEntry(r.model.group, models.currentEffort)));
      onClose();
    }
  };
  const enterScope = (to: CommandScope) => {
    onScope(to);
    setQuery("");
    setActive(to === "permissions" ? currentModeAt : 0);
  };
  const enterModels = () => enterScope("models");
  const leaveModels = () => {
    onScope("all");
    setQuery("");
    setActive(0);
  };

  const starts = groupStarts(groups); // each group's first row in `rows`
  const hitRow = (h: SearchHit, i: number) => (
    <HitRow key={h.key} hit={h} selected={current?.kind === "hit" && current.hit === h} avatar={avatar} onPoint={() => setActive(i)} onOpen={() => open(h)} />
  );
  const searchCount = typed ? flatHits(groups).length : places.length;
  const activeId = inModels ? (sw.active ? modelOptionId(sw.active.key) : undefined) : current ? optionId(rowKey(current)) : undefined;
  return (
    <Sheet
      label={inModels ? "Switch model" : inModes ? "Change permission mode" : "Search"}
      onClose={onClose}
      width={640}
      top="10vh"
      clear
      className="loki-search"
      cardProps={{ "data-search": "" }}
    >
      <form
        role="search"
        className="loki-search-bar"
        onSubmit={(e) => {
          e.preventDefault();
          if (inModels) {
            if (sw.active) pickModel(sw.active);
          } else if (current) take(current);
        }}
      >
        <Icon name="search" size={18} className="loki-search-glass" />
        {scoped && (
          <span className="loki-search-scope">
            {inModels ? "Models" : "Permissions"}
            <button
              type="button"
              className="loki-search-scope-x"
              aria-label="Search everything"
              tabIndex={-1}
              onPointerDown={(e) => e.preventDefault()}
              onClick={leaveModels}
            >
              <Icon name="close" size={12} />
            </button>
          </span>
        )}
        <input
          className="loki-search-input"
          value={query}
          onChange={(e) => {
            const text = e.target.value.slice(0, 200);
            if (!scoped && models && MODELS_PREFIX.test(text)) return enterModels();
            if (!scoped && modes && PERMISSIONS_PREFIX.test(text)) return enterScope("permissions");
            setQuery(text);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (inModels) {
              if (e.key === "Backspace" && !query) {
                e.preventDefault();
                leaveModels();
              } else if (sw.onKey(e.key)) e.preventDefault();
              return;
            }
            if (inModes && e.key === "Backspace" && !query) {
              e.preventDefault();
              leaveModels();
              return;
            }
            if (e.key === "Tab" && !e.shiftKey && !inModes && (current?.kind === "model" || current?.kind === "mode")) {
              e.preventDefault();
              enterScope(current.kind === "model" ? "models" : "permissions");
              return;
            }
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            if (rows.length) setActive((a) => (Math.min(a, rows.length - 1) + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length);
          }}
          placeholder={
            inModels
              ? models?.agentName
                ? `Switch ${models.agentName}'s model`
                : "Switch model"
              : inModes
                ? "Change this chat's permission mode"
                : "Search chats, agents, pages and commands"
          }
          aria-label={inModels ? "Switch model" : inModes ? "Change permission mode" : "Search"}
          role="combobox"
          aria-expanded={inModels ? sw.groups.length > 0 : rows.length > 0}
          aria-controls={inModels ? "loki-model-switch-list" : LIST_ID}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-describedby={scoped ? undefined : "loki-search-coverage"}
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore
          data-form-type="other"
        />
      </form>
      <p className="sr-only" aria-live="polite">
        {!inModels && typed ? (found ? `${found} ${found === 1 ? "result" : "results"}` : "No results") : ""}
      </p>
      <div ref={scroller} className="loki-search-body">
        {inModels ? (
          models ? (
            <ModelSwitchList sw={sw} query={typed} />
          ) : (
            <div className="loki-search-empty">
              <p className="loki-search-miss">Open a chat to switch its model</p>
            </div>
          )
        ) : inModes ? (
          modes ? (
            <>
              <div id={LIST_ID} role="listbox" aria-label="Permission modes">
                <ul className="loki-list" role="presentation">
                  {modeHits.map((m, i) => (
                    <ModeRow
                      key={m.id}
                      mode={m}
                      current={m.id === modes.current}
                      selected={current?.kind === "mode" && current.mode.id === m.id}
                      onPoint={() => setActive(i)}
                      onPick={() => take({ kind: "mode", mode: m })}
                    />
                  ))}
                </ul>
              </div>
              {modeHits.length === 0 && (
                <div className="loki-search-empty">
                  <p className="loki-search-miss">No mode matches “{typed}”</p>
                </div>
              )}
            </>
          ) : (
            <div className="loki-search-empty">
              <p className="loki-search-miss">Open a chat to change its permission mode</p>
            </div>
          )
        ) : (
          <>
            {!typed && places.length > 0 && (
              // The recents' heading sits outside the listbox: its Clear is a button, not an option.
              <div className="loki-search-group-head">
                <span id="loki-search-recent" className="loki-search-group-title">
                  Recent
                </span>
                <span style={{ flex: 1 }} />
                <button type="button" className="loki-search-clear" onClick={() => (recentPlaces.clear(), setPlaceKeys([]))}>
                  Clear
                </button>
              </div>
            )}
            <div id={LIST_ID} role="listbox" aria-label={typed ? "Results" : undefined} aria-labelledby={typed ? undefined : "loki-search-recent"}>
              {typed ? (
                groups.map((g, gi) => (
                  <Group key={g.id} title={g.title} note={g.total > g.hits.length ? `${g.hits.length} of ${g.total}` : null}>
                    {g.hits.map((h, i) => hitRow(h, starts[gi] + i))}
                  </Group>
                ))
              ) : (
                <ul className="loki-list" role="presentation">
                  {places.map((h, i) => hitRow(h, i))}
                </ul>
              )}
              {commandHits.length > 0 && (
                <Group title="Commands">
                  {commandHits.map((c, i) => (
                    <CommandRow
                      key={c.id}
                      command={c}
                      selected={current?.kind === "command" && current.command.id === c.id}
                      onPoint={() => setActive(searchCount + i)}
                      onRun={() => take({ kind: "command", command: c })}
                    />
                  ))}
                </Group>
              )}
              {modelHits.length > 0 && (
                <Group title="Models" note={`Tab for all of ${models?.agentName ?? "this chat"}'s models`}>
                  {modelHits.map((m, i) => (
                    <ModelRow
                      key={m.key}
                      row={m}
                      selected={current?.kind === "model" && current.model.key === m.key}
                      onPoint={() => setActive(searchCount + commandHits.length + i)}
                      onPick={() => take({ kind: "model", model: m })}
                    />
                  ))}
                </Group>
              )}
              {modeHits.length > 0 && modes && (
                <Group title="Permissions" note="Applies to this chat">
                  {modeHits.map((m, i) => (
                    <ModeRow
                      key={m.id}
                      mode={m}
                      current={m.id === modes.current}
                      selected={current?.kind === "mode" && current.mode.id === m.id}
                      onPoint={() => setActive(searchCount + commandHits.length + modelHits.length + i)}
                      onPick={() => take({ kind: "mode", mode: m })}
                    />
                  ))}
                </Group>
              )}
            </div>
            {typed && rows.length === 0 && (
              <div className="loki-search-empty">
                <p className="loki-search-miss">No matches for “{typed}”</p>
              </div>
            )}
            {!typed && places.length === 0 && (
              <div className="loki-search-empty">
                <p className="loki-search-miss">Search loki</p>
                <p className="loki-meta loki-meta--wrap">Chats and pages you open show here.</p>
              </div>
            )}
          </>
        )}
      </div>
      {inModels ? (
        models && <ModelSwitchFoot sw={{ ...sw, pick: (row, effort) => pickModel(row, effort) }} />
      ) : inModes ? (
        <p className="loki-meta loki-meta--wrap loki-search-coverage">Applies to this chat. ↑ ↓ to move, {formatKeys("enter")} to change.</p>
      ) : (
        <p id="loki-search-coverage" className="loki-meta loki-meta--wrap loki-search-coverage">
          {COVERAGE} ↑ ↓ to move, {formatKeys("enter")} to open.
        </p>
      )}
    </Sheet>
  );
}

/** A permission mode as a listbox option: its name over the line saying what it lets through, the chat's own checked. */
function ModeRow({
  mode,
  current,
  selected,
  onPoint,
  onPick,
}: {
  mode: SharedMode;
  current: boolean;
  selected: boolean;
  onPoint: () => void;
  onPick: () => void;
}) {
  return (
    <li id={optionId(`mode:${mode.id}`)} role="option" aria-selected={selected} className="loki-list-item">
      <div className="loki-list-row loki-search-row" onPointerDown={(e) => e.preventDefault()} onPointerMove={selected ? undefined : onPoint} onClick={onPick}>
        <span className="loki-list-row-copy">
          <span className="loki-list-row-title">
            <span className="loki-list-row-name">{mode.label}</span>
          </span>
          {mode.description && <span className="loki-list-row-preview">{mode.description}</span>}
        </span>
        {current && <Icon name="check" size={16} className="loki-model-switch-check" />}
      </div>
    </li>
  );
}

/** A command as a listbox option: its label, its key on the right; the field keeps focus. */
function CommandRow({ command, selected, onPoint, onRun }: { command: CommandHit; selected: boolean; onPoint: () => void; onRun: () => void }) {
  return (
    <li id={optionId(`command:${command.id}`)} role="option" aria-selected={selected} className="loki-list-item">
      <div className="loki-list-row loki-search-row" onPointerDown={(e) => e.preventDefault()} onPointerMove={selected ? undefined : onPoint} onClick={onRun}>
        <span className="loki-list-row-lead">
          <ListIcon name="menu" />
        </span>
        <span className="loki-list-row-copy">
          <span className="loki-list-row-title">
            <span className="loki-list-row-name">{command.label}</span>
          </span>
        </span>
        {command.keys && (
          <span className="loki-meta" aria-hidden>
            {command.keys}
          </span>
        )}
      </div>
    </li>
  );
}

/** Where each group's rows start in the flat list, the groups in order (a counter in render keeps the React Compiler off). */
function groupStarts(groups: ReadonlyArray<{ hits: readonly unknown[] }>): number[] {
  const out: number[] = [];
  let at = 0;
  for (const g of groups) {
    out.push(at);
    at += g.hits.length;
  }
  return out;
}

/** A group of options: a quiet heading, and how many of how many when capped, over its rows. */
function Group({ title, note, children }: { title: string; note?: string | null; children: ReactNode }) {
  const id = `loki-search-group-${title.toLowerCase()}`;
  return (
    <div role="group" aria-labelledby={id} className="loki-search-group">
      <div className="loki-search-group-head">
        <span id={id} className="loki-search-group-title">
          {title}
        </span>
        {note && <span className="loki-meta">{note}</span>}
      </div>
      <ul className="loki-list" role="presentation">
        {children}
      </ul>
    </div>
  );
}

/** One result: ListRow's anatomy as a listbox option — the lead, the title over its line; highlighted while chosen. */
function HitRow({
  hit,
  selected,
  avatar,
  onPoint,
  onOpen,
}: {
  hit: SearchHit;
  selected: boolean;
  avatar: (agentId: string) => string | null;
  onPoint: () => void;
  onOpen: () => void;
}) {
  const lead = "agent" in hit.lead ? <AgentFace name={hit.lead.agent.name} src={avatar(hit.lead.agent.id)} /> : <ListIcon name={hit.lead.icon} />;
  return (
    <li id={optionId(hit.key)} role="option" aria-selected={selected} className="loki-list-item" data-dim={hit.dim || undefined} data-launch={hit.key}>
      {/* The field keeps focus; a press would take it, so the row opens on click without ever being focused. */}
      <div className="loki-list-row loki-search-row" onPointerDown={(e) => e.preventDefault()} onPointerMove={selected ? undefined : onPoint} onClick={onOpen}>
        <span className="loki-list-row-lead">{lead}</span>
        <span className="loki-list-row-copy">
          <span className="loki-list-row-title">
            <span className="loki-list-row-name">{hit.title}</span>
          </span>
          <span className="loki-list-row-preview">{hit.preview}</span>
        </span>
        {selected && (
          <span className="loki-meta" aria-hidden>
            {formatKeys("enter")}
          </span>
        )}
      </div>
    </li>
  );
}
