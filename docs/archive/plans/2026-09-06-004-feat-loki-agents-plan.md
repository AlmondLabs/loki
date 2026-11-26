# loki agents: a place to see and shape ira and friday — plan of record

Decided 2026-09-06 with Deepak ("The current UI has no sense of Agents"). An Agents segment
(⌘4; settings moves to ⌘5 and keeps ⌘,) with one page per agent, read-first.

## What Letta keeps per agent (verified on disk)

- `~/.letta/lc-local-backend/agents/<b64 id>.json`: name, description, model, model_settings
  (provider, effort, thinking, context window), system prompt, tags (favorite:…, git-memory-enabled).
- `~/.letta/lc-local-backend/memfs/<id>/memory/`: a git repo — `system/persona.md`, `system/human.md`,
  `reference/**`, `skills/<name>/SKILL.md`, `profile.png` (512×512). Every memory change is a commit.
- App-server: `agent_retrieve`/`agent_update {agent_id, body}`, `memory_history {agent_id, file_path?}`,
  `memory_commit_diff {agent_id, sha}`, `memory_file_at_ref`, `read_memory_file {agent_id, path}`,
  `list_models`, `skill_enable {skill_path}` / `skill_disable {name}` (these two are GLOBAL skills in
  ~/.letta/skills, not per agent).

## Decisions

- D1 **Read through the mod, write through the app-server.** The mod reads the record and the memory
  filesystem from disk (tree, files, `git log`, `git show`, the face over HTTP); the browser tab works
  the same way as the Tauri app. Name, description and model change through `agent_update`.
- D2 **Memory is the agent's.** No editing of memory files from loki. "Ask ira to update this" opens
  the agent's main chat with the request started, naming the file. Same single-writer rule as the board.
- D3 **Faces everywhere they are cheap**: the tree's agent groups, inbox cards, the Agents page.
- D4 Skills shown are the agent's memory skills (read-only). Global enable/disable is not wired yet.
- D5 Not doing yet: create/delete agents, editing the system prompt, memory file editing.

## Shape

    mod/agents.ts   readLocalAgent · memoryTree · memorySkills · readMemoryFile · memoryLog · memoryDiff · profilePath
    bridge frames   agent_get · memory_read · memory_log · memory_diff  (+ GET /agents/<id>/profile.png?t=)
    app/src/agents  Agents.tsx: tabs of faces → identity (editable name/description/model) · memory tree ·
                    skills · where (desks, tasks) | viewer (markdown file or coloured diff) · learned recently
