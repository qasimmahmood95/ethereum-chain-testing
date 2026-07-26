# Milestone plan

One PR per milestone. Each milestone ends with a code-review subagent
pass over the full diff, then the PR, then a verification-subagent run
from a clean checkout against Anvil. CI must stay under 5 minutes
throughout. Scenario IDs (S1..S16) refer to `docs/SCENARIOS.md`.

## M0: plan and docs

Goal: the project charter (`CLAUDE.md`), this milestone plan and the
scenario ↔ invariant ↔ custody-risk table (`docs/SCENARIOS.md`) land
before any code, so every later PR can be judged against them.

Exit criteria: docs merged; every later milestone maps to scenarios in
`docs/SCENARIOS.md`.

## M1: scaffold and Anvil harness

Goal: a repo where `npm ci && npm run lint && npm run typecheck &&
npm test` passes locally (Windows) and in CI (Linux), with a real Anvil
spawned and torn down by the harness, and every decision record in place
before any custody logic exists.

Deliverables:

- `package.json` (strict ESM, Node LTS engines), `tsconfig.json`
  (`strict`, `noUncheckedIndexedAccess`), vitest, viem, eslint and
  prettier configs, LICENSE (MIT), .gitignore, .editorconfig.
- `test/harness/anvil.ts`: spawn Anvil on a free port, wait for RPC,
  assert chain id 31337, tear down; per-suite isolation, with
  snapshot/revert reset between tests where a suite opts in. Works with
  `anvil.exe` on Windows and `anvil` on Linux.
- One smoke test: mine a block via the viem test client, read it back,
  prove harness output (port, anvil version) appears in CI logs.
- GitHub Actions: foundry-toolchain (pinned version), lint + typecheck +
  test on every branch push; a separate gitleaks job. gitleaks also
  wired as a pre-commit hook.
- All four ADRs: `0001-anvil-over-mocks`,
  `0002-reorg-simulation-snapshot-revert`, `0003-nonce-idempotency`,
  `0004-local-deploy-vs-pinned-fork`.

Exit criteria: green CI well under 5 minutes; ADRs reviewed; harness
boots Anvil in under a second per suite; gitleaks blocks a planted fake
key locally.

## M2: deposit watcher and confirmation depth

Goal: the watcher state machine for native ETH deposits — seen at
1 conf, credited at N — as pure logic fed by chain observations, driven
end to end against Anvil. Covers S1, S2, S3.

Deliverables:

- `src/types.ts`: branded types; `bigint` wei; deposit states
  (`seen` → `credited`, plus removal on reorg); confirmation depth as
  explicit config.
- `src/watcher.ts`: pure state machine — input: new block headers and
  matching deposits (with inclusion block hash and height); output:
  state transitions and credit events. Tracks block hashes, not just
  heights, because M3 depends on it.
- `src/rpc/`: minimal viem adapter — get block, get balance, watch
  range of blocks for txs to watched addresses.
- Integration tests: deposit lifecycle across mined blocks, including
  the N-1 boundary (S3) and exact-wei crediting (S2).

Exit criteria: S1–S3 green against Anvil; watcher core has no viem
import; the N-1 boundary test demonstrably fails if the depth compare
is loosened locally.

## M3: reorg handling

Goal: deterministic reorgs via `evm_snapshot`/`evm_revert`, and a
watcher that survives them. The headline test: a deposit un-credits
when reorged out before confirmation depth. Covers S4, S5, S6, S7.

Deliverables:

- `test/harness/reorg.ts`: snapshot at height H; mine the "original"
  branch containing the deposit; revert; mine a longer replacement
  branch. Replacement blocks get distinct timestamps
  (`evm_setNextBlockTimestamp`) so block hashes genuinely differ —
  otherwise Anvil can re-mine byte-identical blocks and the "reorg" is
  invisible. Helper supports: tx absent from replacement chain (S4) and
  tx re-included at a different height (S5).
- Watcher reorg logic: detect ancestry break by parent-hash mismatch,
  rewind to the common ancestor, replay observations from there (S6).
  A deposit whose inclusion block left the canonical chain reverts to
  unseen/seen; credit only ever counts confirmations on the current
  canonical chain (S5). A reorg deeper than N (credited deposit
  invalidated) raises an explicit alarm event — never silent (S7;
  reconciliation in M6 re-checks this).
- ADR-0002 finalized with what snapshot/revert does and does not model
  (no competing-miner fork choice; `anvil_reorg` noted as alternative).

Exit criteria: S4–S7 green; S4 demonstrably fails when the ancestry
check is disabled locally (that becomes the M7 defect branch).

## M4: nonce management and broadcast idempotency

Goal: a broadcaster where a retry after timeout can never
double-broadcast, reuse a nonce for a different intent, or double-spend.
Covers S8, S9, S10.

Deliverables:

- `src/broadcaster.ts` + `src/nonce.ts`: intent store keyed by
  idempotency key. Flow: allocate nonce from the local monotonic
  allocator, sign, persist `{intent, nonce, rawTx, hash}` _before_ first
  broadcast, then send. A retry looks up the stored raw tx and
  rebroadcasts the identical bytes — it never re-signs and never
  re-reads the pending nonce from the node. Concurrent submits of one
  intent serialize on the store and return the same hash.
- Integration tests with automine off: broadcast, time out without a
  receipt, retry, mine — exactly one transfer on chain, one nonce
  consumed (S8). Two concurrent submits of the same intent (S9). A
  burst of distinct intents with interleaved retries — nonces strictly
  monotonic and gapless, everything confirms (S10).
- ADR-0003 finalized (persist-before-broadcast, rebroadcast-bytes,
  local allocator as source of truth for pending nonces).

Exit criteria: S8–S10 green; S8 demonstrably fails (two transfers on
chain) when the retry path is switched to re-sign with a fresh pending
nonce locally.

## M5: dropped and stuck transactions

Goal: mempool eviction and fee-bump/replacement behaviour. Covers S11,
S12.

Deliverables:

- Harness helpers: `anvil_dropTransaction` for eviction,
  `anvil_setNextBlockBaseFeePerGas` plus automine-off for the
  stuck-underpriced case.
- Broadcaster additions: detect non-inclusion after a deadline;
  rebroadcast the identical raw tx after eviction (S11); deliberate
  replacement — same nonce, properly bumped fees, recorded as
  superseding the original under the same intent, so the intent
  completes at most once whichever tx confirms (S12).
- Integration tests: eviction then rebroadcast, exactly one transfer
  (S11); stuck tx then bump, exactly one of {original, replacement}
  confirms, never both, never neither (S12).

Exit criteria: S11–S12 green; the S12 test demonstrably fails if
replacement is issued under a new nonce locally.

## M6: ERC-20 deposits and reconciliation

Goal: token deposit watching (light touch) and the reconciliation
sweep that ties the repo back to reconciliation-testing. Covers S13,
S14, S15, S16.

Deliverables:

- `contracts/`: minimal ERC-20 fixture (mint + transfer, configurable
  decimals), source plus committed build artifact; deployed fresh per
  suite. Test tokens at 6 and 18 decimals.
- `src/erc20.ts`: Transfer-log decoding into `bigint` minor units,
  deposits keyed by `(txHash, logIndex)`. fast-check property for
  minor-unit conversion round-trip past 2^53 (the
  reconciliation-testing mindset applied to token decimals).
- Watcher extended to token deposits — same state machine, same reorg
  handling (S15 reuses the M3 harness).
- `src/reconcile.ts`: credited set vs chain truth (`eth_getBalance` /
  `balanceOf` at the depth-N block) per (address, asset); typed report
  of exact deltas; zero discrepancies on the happy path; a
  deeper-than-N reorg (S7) surfaces here as an exact discrepancy.
- Integration tests: S13, S14 (zero-value transfers, multiple
  transfers in one tx/block), S15, S16 (reconciliation after a
  scripted mix of deposits, reorgs, retries and bumps).

Exit criteria: S13–S16 green; the decimals property demonstrably
shrinks when the decoder is switched to `Number` locally.

## M7: planted-defect branches

Goal: long-lived `defect/*` branches, each one plausible commit on top
of `main`, each caught in CI by the intended scenario.

| Branch                     | Planted bug (reads like a sensible change)                                                                    | Caught by                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `defect/early-credit`      | confirmation compare loosened by one (`>=` for `>`), "off-by-one fix" — credits at N-1                        | S3 boundary test; S4 gets riskier too       |
| `defect/reorg-blind`       | "cache headers by height to cut RPC calls" — drops the parent-hash ancestry check, credit survives a reorg    | S4 un-credit test (the headline)            |
| `defect/retry-fresh-nonce` | "handle nonce drift on retry" — retry re-signs with `getTransactionCount('pending')` instead of stored raw tx | S8 idempotency test: two transfers on chain |
| `defect/decimals-number`   | "simplify decoding" — token amounts through `Number`, exact below 2^53, wrong above                           | S13 property, shrunk counterexample         |

Process per branch: plant the bug, verification subagent confirms from
a clean checkout that the suite fails on the intended test and nothing
else, push, capture the red CI run URL and failure output for the
README.

Exit criteria: four red CI runs, each failing on the intended scenario;
`main` still green.

## M8: README and polish

Goal: the repo reads clearly in one pass.

Deliverables:

- README: the custody/chain-boundary thesis; Anvil as Ethereum's
  regtest; the scenario table (or a distilled version linking
  `docs/SCENARIOS.md`); each defect branch's failure output quoted
  inline with links to the red runs; how to run locally (foundry
  prerequisite); ADR links; honest scope statement; links to
  bitcoin-chain-testing and reconciliation-testing.
- CI badge, repo description and topics.
- Final verification pass: `main` green, all defect branches red on the
  intended test.

Exit criteria: a reader landing cold sees a reorged-out deposit
un-credit within one screen and can reproduce it in two commands.

## Optional follow-on: pinned-fork lane

Not a numbered milestone; do only if it earns its keep. Run the watcher
scenarios against a pinned-block mainnet fork (e.g. real USDC) with the
fork state cached (`actions/cache` keyed on the fork block, or
`anvil_dumpState` committed if small enough). Skipped automatically
when no cache/RPC secret is present — CI never depends on a live RPC.
ADR-0004 records the trade-off either way.

## Out of scope

Production contract development, real keys or funds or live networks,
gas-price strategy beyond minimal fee bumps, MEV, multi-node consensus,
finality gadgets (a reorg deeper than N is alarmed, not handled),
persistence beyond in-memory stores, any service layer.
