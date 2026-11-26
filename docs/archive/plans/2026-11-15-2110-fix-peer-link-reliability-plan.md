---
title: Paired Macs that stay connected - Plan
type: fix
date: 2026-11-15
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Paired Macs that stay connected - Plan

---

## Goal Capsule

- **Objective:** two paired Macs that can reach each other over Tailscale show each other's chats and stay paired,
  and when they cannot connect the log says why.
- **Means:** four fixes in the peer path found while reviewing a Mac mini and MacBook Pro that would not connect:
  the chat list's fetch, the listener's tailnet check, the status a refused socket gets, and the link's log.
- **Authority:** the Requirements, then the Key Technical Decisions.
- **Stop conditions.** Stop and ask if a fix would change what a phone may open, or the peer protocol.
- **Execution profile:** `mod/remote-chats.ts`, `mod/lan.ts`, `mod/server.ts`, `mod/peer-link.ts` and their tests; one PR.
- **Who finishes:** `ce-work` on branch `fix/peer-link-reliability`.

---

## Product Contract

### Requirements

- R1. A paired Mac whose link is up keeps its chats in this Mac's lists when one fetch of them fails, and the fetch
  is tried again until it answers or the link goes down. Its chats are marked out of reach only when the link is.
- R2. A paired Mac connecting over the tailnet is let in from the moment the listener is up, and while the
  Tailscale CLI is slow or failing; a caller on a Wi‑Fi that hands out 100.x addresses still is not.
- R3. A Mac turned away for the network path it came by is not told its token is unknown, so it never forgets the
  pairing over a path problem.
- R4. Each reason a link fails (no address, no token in the keychain, refused, the network's own error) is written
  to `mod.log` once when it starts, not once per retry and not never.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **The link's status decides reachability.** RemoteChats marks a Mac out of reach on a failed fetch only when
  its link is no longer `reachable`; otherwise it keeps the last list and retries with the link's own backoff (one
  second doubling to thirty). (R1)
- KTD2. **Tailscale's own interface proves the path.** A 100.64/10 caller counts as the tailnet when it reached an
  address that Tailscale's interface holds, or the CLI's address. On the Mac every VPN is a `utun`, so Tailscale's is
  the one that also holds an address in Tailscale's IPv6 prefix, fd7a:115c:a1e0::/48; elsewhere it is named
  `tailscale*`. Wi‑Fi interfaces and other VPNs' tunnels never count, which keeps the carrier-NAT guard of plan
  Addendum 3. (R2)
- KTD3. **Authorize says how it refused.** A refusal carries a status: 401 for a token nobody knows, 403 for a
  request that came the wrong way or from a foreign page. The upgrade answers with it; browsers never see an
  upgrade's status, so phones are unchanged. Only a 401 makes the other Mac check whether it was forgotten. (R3)
- KTD4. **One line per new reason.** The link remembers the last reason it logged and logs again only when the
  reason changes or after it was reachable. (R4)

### Scope Boundaries

- The peer protocol number stays 1; bumping it is its own change.
- No change to how a pairing is forgotten when the other Mac truly no longer knows this one.

---

## Verification Contract

Tests: `test/remote-chats.test.ts` (a failed fetch on a reachable link keeps and retries), `test/lan.test.ts` (the
tailnet check from interfaces), `test-node/peer-link.node-test.ts` (a wrong path is 403 and not "forgotten"; a link
with no token logs once). Then `npm run format:check && npm run lint && npm run typecheck && npm test && npm run
test:node`, and `npm run build:app && npm run build:mod && npm run smoke`.
