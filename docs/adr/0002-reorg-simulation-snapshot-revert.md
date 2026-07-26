# 0002: Reorg simulation via snapshot/revert

Status: accepted; finalized in M3

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
watcher (`test/harness/reorg.ts`).

## What this models — measured in M3

- `evm_revert` restores chain _and_ txpool state, so the original
  branch's txs vanish with it; S5 re-includes the same tx by re-sending
  with pinned nonce and fees, which reproduces the identical hash
  (Anvil signs deterministically, RFC 6979).
- The first replacement block's base fee and hash-relevant fields are
  identical to the original's except the forced timestamp — the
  divergence is real but minimal, which is exactly what a hash-tracking
  watcher must catch (S6).
- Fork choice is not modeled: no competing miner, no reorg decision by
  the node. The harness imposes the "longer replacement wins" outcome;
  the watcher's `reorgTo` requires a strictly longer replacement for
  the same reason.
- `anvil_reorg` exists as an alternative and was not adopted: it
  rebuilds a forked history in one call but scripts the replacement
  contents less directly than mining them explicitly.

## Consequences

- Both branches are fully controlled, so tests assert exact post-reorg
  state (un-credit, re-credit at new height, alarm — S4/S5/S7).
- Snapshots are consumed by revert; the harness re-snapshots per test,
  and nested snapshots (suite reset + per-test fork point) compose.
