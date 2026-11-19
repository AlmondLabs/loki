---
title: Fast PR checks - Plan
type: ci
date: 2026-11-17
execution: code
---

# Fast PR checks - Plan

## Goal

A PR gets its CI result in under 2 minutes at the median and under 3 at p95, without CI hiding a failure: no retries,
no wider timeouts, no skipped tests. A check that needs a retry has a bug, and the bug gets fixed.

## Where the time went (the last 150 `ci` runs, 2026-11-05 to 2026-11-17)

Each job split into waiting (queued), setup (checkout, Node, `npm ci`, post steps) and running, in seconds:

| Job                               |   n | wait p50/p95 | setup p50/p95 | run p50/p95 | total p50/p95 |
| --------------------------------- | --: | -----------: | ------------: | ----------: | ------------: |
| types, lint, tests and bundles    | 147 |        2 / 3 |       30 / 63 |   205 / 284 |     253 / 324 |
| tests (windows-latest)            | 148 |        2 / 4 |      94 / 112 |   104 / 156 |     206 / 272 |
| tests (macos-15)                  | 105 |      3 / 302 |       72 / 96 |    92 / 128 |     173 / 428 |
| The run, first job to last result | 149 |              |               |             |     260 / 360 |

The biggest bucket is the Linux job's running time: eight checks one after another, lint alone 78 s, the suite 46 s,
the app build 25 s, types 21 s, Prettier 14 s. Next is setup on Windows and the Mac, where `npm ci` takes 60 to 75 s,
then the macOS queue at p95.

## Steps, one PR each, with before and after numbers from real runs

1. **Shape.** Types, format, lint, the suite and the bundles in jobs of their own, side by side. The run takes as long
   as its slowest job.
2. **Setup.** Cache `node_modules` itself per system and lockfile, seeded from main so a PR hits it; a blobless clone.
3. **Lint, format, types.** oxlint, oxfmt and a faster typecheck, each run beside the old tool first, with what the new
   one misses listed in its PR. A tool stays where the new one misses rules this repository relies on.
4. **Tests.** Reuse the module graph across files where the tests allow it, reset state after each file, run in random
   order, shard by measured duration.
5. **Selection and the merge queue.** On a PR, run what the diff can reach; the full suite runs in a merge queue before
   anything reaches main. Hide a change from the selection on purpose and confirm CI goes red.
6. **Local.** A pre-push hook that checks format, lint and types on the changed files. Done: `npm install` points git at
   `.githooks/`; the hook takes about 1s on a usual branch and 2s on one that changes 150 files, and catches a planted
   format, lint, naming and type error each.
7. **Budgets.** Each job fails when it runs past its budget.

Moving runners off GitHub's hosted ones, the merge queue's ruleset and anything else that needs an account, a secret
or a bill are listed for the owner rather than done here.

The owner chose to stay on GitHub's hosted runners (2026-11-19), so the Mac runner's queue stays. Instead a PR waits
for a Mac only when its diff can reach what differs there: not for the app, the site, docs or tests of the app. Over
the last 150 merged PRs that skips the Mac job on 35, and still runs it on all 5 where it alone went red.
