# Speed Up CI and Local Verification Checks

Date: 2026-11-28

## Goals

Eliminate unnecessary full-suite fallbacks and serial bottlenecks across GitHub CI and local verification without relaxing any check coverage.

## Changes

1. **Incremental test selection on doc-carrying feature PRs (`scripts/select-tests.ts`, `test/select-tests.test.ts`)**
   - Ignore doc files (`docs/**`, `LICENSE`, `.github/ISSUE_TEMPLATE/**`, root `*.md`) in `selectTests` instead of falling back to the full 333-file suite whenever a PR includes its plan in `docs/plans/` or updates `docs/manual.md`. Tests that inspect docs or repo files on disk remain included via `treeReaders()`.
   - Include `.mjs` test fixture modules in `CODE` so fixture changes run `vitest related` rather than forcing `{ all: true }`.
2. **Windows sharding & selective site build in GitHub CI (`.github/workflows/ci.yml`, `test/workflows.test.ts`)**
   - Split Windows Vitest runs from 2 shards to 3 shards (`--shard=${{ matrix.shard }}/3`) so full-suite runs stay comfortably below the 60s per-shard budget.
   - Skip `build:site` in the `bundles` job on PRs that do not touch `site/`, `app/src/kit/`, `package.json`, `bun.lock`, or `tsconfig*` (while keeping it unconditional on merge queues and scheduled runs).
3. **Skip unnecessary gzip measurement in Vite builds (`app/vite.config.ts`, `site/vite.config.ts`)**
   - Set `build.reportCompressedSize: false` so `vite build` skips compressing all output chunks solely to log gzipped sizes.
4. **Parallelize `install.sh` Node tests (`test-node/install-script.node-test.ts`)**
   - Replace synchronous `spawnSync("sh", ...)` in `install()` with async `spawn` and run the independent `install.sh` cases concurrently (`concurrency: true`).
5. **Parallel local verification scripts (`scripts/verify.ts`, `package.json`, `test/verify.test.ts`, `AGENTS.md`)**
   - Add `bun run verify` (runs `format:check`, `typecheck`, `lint`, `test`, `test:node`, and `build:app -> build:mod -> smoke` concurrently) and `bun run verify:pr` (runs `lint:pr`, `test:pr`, and skips rebuilding `app/dist` when unchanged).
