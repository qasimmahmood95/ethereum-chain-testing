# Integration scenarios

Each scenario is one integration test (or small family) against Anvil.
The invariant is what the test asserts; the custody risk is the real
loss mode it maps to. N is the configured confirmation depth (small in
tests, e.g. 5, so suites stay fast). Milestones refer to
`docs/PLAN.md`.

## Confirmation depth (M1)

| ID  | Scenario                                                          | Invariant asserted                                                                              | Custody risk it maps to                                                                      |
| --- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| S1  | Deposit tx mined; watcher at 1 conf                               | Deposit recorded as *seen* with exact wei amount; never credited below N confirmations           | Crediting at 1 conf lets a customer withdraw against funds a shallow reorg can erase          |
| S2  | Head reaches inclusion + N − 1 (N confs)                          | Credit happens exactly once, at exactly depth N, amount equal to on-chain value in wei           | Double-credit inflates liabilities; a missed credit strands customer funds                    |
| S3  | Head at exactly N − 1 confs                                       | Still *seen*, not credited — the boundary holds                                                  | An off-by-one silently weakens the confirmation policy by one block, chain-wide               |

## Reorg handling (M2)

| ID  | Scenario                                                          | Invariant asserted                                                                              | Custody risk it maps to                                                                      |
| --- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| S4  | Deposit at < N confs; snapshot/revert reorg to a replacement chain without the tx; head passes the old height | Deposit un-credits: removed from *seen*, never credited, available balance excludes it; later re-inclusion is a fresh sighting | The classic exchange reorg loss — customer credited for a deposit the chain no longer contains |
| S5  | Same deposit tx re-included at a different height/hash on the replacement chain | Confirmations count only from the new inclusion block on the canonical chain                     | Counting stale confirmations from the orphaned block credits early                            |
| S6  | Replacement chain has same heights, different hashes              | Watcher detects the ancestry break by parent-hash mismatch, rewinds to the common ancestor, replays; state never mixes two forks | A fork-blind watcher (tracking heights, not hashes) silently diverges from the canonical chain |
| S7  | Reorg deeper than N invalidates an already-credited deposit       | Explicit alarm event, and reconciliation (S16) reports the exact discrepancy — never silent      | Silent insolvency: the books say funds exist that the chain does not                         |

## Nonce management and broadcast idempotency (M3)

| ID  | Scenario                                                          | Invariant asserted                                                                              | Custody risk it maps to                                                                      |
| --- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| S8  | Broadcast times out (no receipt, automine off); same intent retried; then mined | Retry rebroadcasts the identical signed bytes — same hash, same nonce; exactly one transfer on chain | Withdrawal double-spend: a timeout retry that re-signs sends the money twice                  |
| S9  | Two concurrent submits of the same intent                         | One nonce allocated, one signed tx; both callers get the same hash                               | Race-condition double-send under load                                                        |
| S10 | Burst of distinct intents with interleaved retries               | Nonces per account strictly monotonic and gapless; every intent confirms exactly once            | A nonce gap silently freezes all later withdrawals; reuse across intents overwrites one withdrawal with another |

## Dropped and stuck transactions (M4)

| ID  | Scenario                                                          | Invariant asserted                                                                              | Custody risk it maps to                                                                      |
| --- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| S11 | Tx evicted from the mempool (`anvil_dropTransaction`)             | Non-inclusion detected; rebroadcast is byte-identical (same hash); funds move exactly once       | Eviction misread as failure triggers a re-sign and double-send; unnoticed eviction strands the withdrawal |
| S12 | Tx stuck underpriced (base fee raised, automine off); fee bump issued | Replacement uses the same nonce with a compliant fee bump; exactly one of {original, replacement} confirms; the intent completes once either way | Bumping under a new nonce lets both confirm — double-spend; no bump leaves funds stranded     |

## ERC-20 deposits (M5, light touch)

| ID  | Scenario                                                          | Invariant asserted                                                                              | Custody risk it maps to                                                                      |
| --- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| S13 | Transfer event to a watched address; tokens at 6 and 18 decimals; amounts past 2^53 | Credit equals the event value exactly, `bigint` minor units end to end; property-tested round-trip | Precision drift on high-decimal tokens — balances slowly and silently wrong                   |
| S14 | Zero-value transfers; multiple transfers to one address in a single tx/block | Deposits keyed by (txHash, logIndex): each log credited individually, exactly once; zero-value events credit nothing | Keying on txHash alone collapses multi-transfer deposits; zero-value spam corrupts dedup      |
| S15 | Token deposit reorged out before depth (M2 harness reused)        | Same un-credit invariant as native ETH (S4)                                                      | Token deposits handled as second-class in reorg logic — a common real-world gap               |

## Reconciliation (M5)

| ID  | Scenario                                                          | Invariant asserted                                                                              | Custody risk it maps to                                                                      |
| --- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| S16 | After a scripted mix of deposits, reorgs, retries and fee bumps, reconcile the credited set against chain truth at the depth-N block | Per (address, asset), credited total equals the chain balance delta at the confirmed height; every discrepancy reported with its exact delta; zero discrepancies on the happy path | Books diverge from chain with no alarm — discovered only when a withdrawal bounces           |
