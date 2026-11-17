---
title: Apple silicon Macs only - Plan
type: chore
date: 2026-11-16
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Apple silicon Macs only - Plan

---

## Goal Capsule

- **Objective:** loki ships for Macs with Apple silicon only; Intel Macs are not supported.
- **Means:** the Mac release builds `aarch64-apple-darwin` instead of a universal app, and every place that names a Mac
  build, download or requirement says Apple silicon.
- **Authority:** the owner's decision (2026-11-16): "I don't want to support mac intel."

---

## Product Contract

### Summary

The Mac release builds for Apple silicon alone, which also halves its compile. The update manifest, the casks, the
install script, the runtime's Node list and the docs drop Intel.

### Requirements

- R1. The Mac release is built for `aarch64-apple-darwin` only: `loki_<v>_aarch64.dmg` and
  `loki_<v>_aarch64.app.tar.gz`, announced in `latest.json` as `darwin-aarch64` alone.
- R2. The install script refuses an Intel Mac before downloading, with a plain message, and still installs on Apple
  silicon when the terminal runs under Rosetta.
- R3. Both casks declare `depends_on arch: :arm64`, so Homebrew refuses an Intel Mac.
- R4. The runtime lists no Intel Node, and an Intel Mac target is an error like any unsupported one.
- R5. The README, the manual and the release docs say Apple silicon. A loki already installed on an Intel Mac keeps
  working but gets no more updates; its About shows the failed check.

### Scope Boundaries

- Rebuilding for Intel on request, or keeping a separate Intel download.
- Removing the leftover `loki-macos-universal.app.tar.gz` from the rolling nightly release (harmless; by hand).
