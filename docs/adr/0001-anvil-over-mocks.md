# 0001: Anvil over mocked RPC

Status: accepted (M1)

## Context

The subject of this repo is the custody/chain boundary: does the
watcher/broadcaster behave correctly against real node semantics —
reorgs, confirmation counting, nonce rules, mempool behaviour? A mocked
RPC encodes our own assumptions about those semantics, which is exactly
the thing under test. Mock-based suites pass while being wrong about
the chain.

## Decision

Integration tests run against a real Anvil node (Foundry), spawned per
suite by the harness on a free port and torn down after. No mocked RPC
in integration tests. The core library stays pure (chain observations
in, decisions out), so unit and property tests need no node at all;
Anvil is the only I/O boundary exercised.

## Consequences

- Foundry becomes a dev and CI prerequisite; its version is pinned in
  CI so failures reproduce byte for byte.
- Anvil boots in well under a second, so per-suite isolation is
  affordable; per-test isolation uses snapshot/revert (ADR-0002).
- Determinism is kept by explicit mining (no interval mining), seeded
  randomness and explicit block heights.
- Anything a single dev node cannot exhibit (peer gossip, competing
  miners, real fork choice) is out of scope and documented as such.
