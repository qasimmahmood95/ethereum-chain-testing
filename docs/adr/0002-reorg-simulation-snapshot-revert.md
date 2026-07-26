# 0002: Reorg simulation via snapshot/revert

Status: accepted (M1); to be finalized with measured behaviour in M3

## Context

The headline scenarios (S4–S7) need deterministic reorgs: a deposit's
inclusion block must leave the canonical chain, on demand, with the
replacement branch's content fully scripted — tx absent, or re-included
at a different height.

## Decision

Reorgs are scripted with `evm_snapshot` / `evm_revert`: snapshot at
height H, mine the original branch containing the deposit, revert, then
mine a longer replacement branch. Replacement blocks get distinct
timestamps via `evm_setNextBlockTimestamp`, otherwise Anvil can re-mine
byte-identical blocks and the "reorg" is invisible to a hash-tracking
watcher.

## Consequences

- Both branches are fully controlled, so tests can assert exact
  post-reorg state (un-credit, re-credit at new height, alarm).
- This models the _effect_ of a reorg on an observer, not fork choice:
  there is no competing miner and no reorg decision by the node.
- `anvil_reorg` exists as an alternative; snapshot/revert is preferred
  for explicit control of the replacement branch's content. Revisit in
  M3 if it proves simpler for S5.
- Snapshots are consumed by revert; the harness re-snapshots per test.
