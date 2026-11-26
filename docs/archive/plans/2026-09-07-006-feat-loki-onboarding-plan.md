# loki · ready for a stranger: providers, agents, skills (2026-09-07)

Decided 2026-09-07 with Deepak: "I think the app is still not ready for general user. I have no
ability to create agents. I have no ability to connect model providers. I have no ability to manage
skills." → "go ahead". Everything below uses requests the installed letta-code (0.31.12) already
answers on its app-server; nothing needs a Letta change.

## What the harness offers (verified in the bundle)

- `list_connect_providers {target:"local"}` → `providers[]`: id, display_name, description,
  provider_type, requires_api_key, `fields[]` {key,label,placeholder?,secret?,required?} or
  `auth_methods[]` {id,label,fields}, `is_oauth?`, `connected {is_connected,…}`. 48 entries here.
- `connect_provider {target, provider_id, fields, auth_method_id?}` checks the key against the
  provider, saves it, returns the refreshed list; `disconnect_provider {target, provider_id}`.
  Both clear the models cache → `list_models {force:true}` afterwards.
- `create_agent {personality: memo|blank|tutorial|linus|kawaii, model?, tags?, pin_global?}` →
  `{agent_id, name, model}`; memory enabled. `agent_update` for name/description. `agent_delete`.
- `write_memory_file {agent_id, path, content, encoding?, commit_message?}`,
  `delete_memory_file {agent_id, path}` — enough to add and remove per-agent skills
  (`skills/<name>/SKILL.md` in the memory repo).
- `skill_enable {skill_path}` symlinks a folder into `~/.letta/skills` (global);
  `skill_disable {name}` removes the link. `skills_updated` event.
- Installing from a URL or registry has no request; the CLI does it:
  `letta install <source> --agent <id> [--force]`. The mod runs it.
- `letta backend local` is non-interactive and writes `preferredBackendMode` to settings.json.

## Decisions

- **First run is a sheet, not a wizard window.** When the harness is linked and lists no agents,
  the desk view shows Welcome: connect a provider (skipped when one is connected), name and choose a
  personality for the first agent, land on its empty desk with the chat open. No agents + no
  provider is the only blocking state; agents without a provider get a brass notice pointing to
  Settings › providers.
- **Providers live in Settings**, as rows: connected first, then the rest behind a filter. A row
  expands into the harness's own field list (secret fields masked, never shown again after
  saving). OAuth entries (ChatGPT, Anthropic OAuth, GitHub Copilot, OpenRouter OAuth) are listed
  with "connect in the terminal: letta connect <id>" — their browser flow is not traced yet.
- **Agents create and delete on the Agents page.** New agent: name, description, personality,
  model (datalist from list_models). Create = `create_agent` with `pin_global:false`, then
  `agent_update` for name and description. Delete asks once and names the live desks and open tasks
  that go with it; it does not touch the board (tasks keep their stamp).
- **Skills.** Per agent: the existing list gains remove (every file under `skills/<name>/`),
  "write one" (name + markdown → SKILL.md with frontmatter) and "install" (source → the CLI via the
  mod, `skill_install` frame). Global: a section on the Agents page listing `~/.letta/skills` with
  disable, and "enable a folder" (path → `skill_enable`).
- **Backend mode.** Before spawning its harness the shell runs `letta backend local` when
  `~/.letta/settings.json` has no `preferredBackendMode`. Cloud users who set cloud keep it.

## Not in this pass

OAuth provider flows inside loki; Letta Cloud sign-in; per-agent skill *disable* (Letta has no
such state, a skill in memory is on); editing memory files in loki (still "ask the agent").

## Addendum (same day): no Letta on the Mac

Deepak: "we should assume that the end user will not have letta on their macbooks. So loki should
try and self discover first. If not found, it should install."

- Discovery (`src-tauri/src/bootstrap.rs`): the user's `letta` on PATH and the usual install dirs
  first, then loki's private copy. Node likewise: PATH, volta, nvm (newest), Homebrew, `/usr/local`,
  private; only a Node ≥ 22.19 (letta-code's engines) counts.
- Install, automatic at launch when nothing is found (`LOKI_NO_BOOTSTRAP=1` stops it): Node 22 from
  `nodejs.org/dist/latest-v22.x/` (SHASUMS256.txt → tarball for the arch → shasum check → tar into
  `<data>/runtime/node`), then `npm install -g --prefix <data>/runtime/letta @letta-ai/letta-code@<pinned>`
  with that Node first on PATH. npm's stderr streams to the page as `loki:bootstrap` events. Then
  `letta backend local` and the harness starts; the app-server link was already retrying.
- The pinned release is `LETTA_CODE_VERSION` in bootstrap.rs; a bun test keeps it equal to
  `TESTED_LETTA_CODE` in shared/compat.ts.
- Welcome gains step 0 "Letta Code" (log tail, retry, the manual command); Settings › requirements
  shows which `letta` is in use and an install button when none is.
- Not done: reusing Letta Desktop's bundled runtime (it is an Electron asar, no CLI inside); Windows/Linux.
