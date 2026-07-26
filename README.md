# ethereum-chain-testing

[![ci](https://github.com/qasimmahmood95/ethereum-chain-testing/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/qasimmahmood95/ethereum-chain-testing/actions/workflows/ci.yml)

Integration tests for the custody/chain boundary on Ethereum. A small
watcher/broadcaster library exists here to be tested: it is exercised
against a **real local node** (Anvil — Ethereum's regtest), with
deterministic reorgs via snapshot/revert, planted-defect branches, and
the red CI runs to prove the tests bite. The thesis: custody software
watches, broadcasts and confirms against the chain, and that boundary —
reorgs, confirmation depth, nonce reuse, dropped transactions, decimal
precision — is where the hard QA lives.

## The headline test

A deposit sitting below confirmation depth **un-credits** when its
inclusion block leaves the canonical chain (S4):

```
snapshot → deposit mined → 2 confirmations → revert → longer branch without the tx
⇒ events: [deposit-removed], credited balance: 0, forever
```

Reproduce it in two commands (prerequisites: Node 22+,
[Foundry](https://getfoundry.sh) so `anvil` is on PATH):

```
npm ci
npx vitest run test/reorg.test.ts
```

## Planted defects, caught red-handed

Four long-lived `defect/*` branches each carry **one plausible commit**
on top of `main` — written to read like a sensible change, with a
commit message that argues for it. CI catches every one. `main` stays
green.

| Branch                                                                                                               | The "sensible" change                                    | Caught by                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [`defect/early-credit`](https://github.com/qasimmahmood95/ethereum-chain-testing/tree/defect/early-credit)           | "fix an off-by-one" — compare loosened, credits at N−1   | S3 boundary ([red run](https://github.com/qasimmahmood95/ethereum-chain-testing/actions/runs/30199665759))    |
| [`defect/reorg-blind`](https://github.com/qasimmahmood95/ethereum-chain-testing/tree/defect/reorg-blind)             | "skip the redundant parent-hash check" — heights suffice | S4 un-credit ([red run](https://github.com/qasimmahmood95/ethereum-chain-testing/actions/runs/30199665904))   |
| [`defect/retry-fresh-nonce`](https://github.com/qasimmahmood95/ethereum-chain-testing/tree/defect/retry-fresh-nonce) | "re-sync the nonce from the node on retry"               | S8 idempotency ([red run](https://github.com/qasimmahmood95/ethereum-chain-testing/actions/runs/30199665738)) |
| [`defect/decimals-number`](https://github.com/qasimmahmood95/ethereum-chain-testing/tree/defect/decimals-number)     | "simplify decoding" — token amounts through `Number`     | S13 property ([red run](https://github.com/qasimmahmood95/ethereum-chain-testing/actions/runs/30199665653))   |

What the failures look like:

**`defect/early-credit`** — the deposit credits one block early; every
exactly-N assertion in the suite (S2, S3, S5, S13 and the boundary unit
tests — 7 tests across 4 files) goes red. One off-by-one, pinned
everywhere the invariant is asserted:

```
FAIL  S3: at exactly N-1 confirmations the deposit is still only seen
AssertionError: expected [ 'deposit-seen', 'deposit-credited' ] to deeply equal [ 'deposit-seen' ]
```

**`defect/reorg-blind`** — the watcher never notices the fork; the
reorged-out deposit survives and goes on to credit (S4–S7, S15, S16):

```
FAIL  S15: a token deposit reorged out before depth un-credits like native ETH
AssertionError: expected [ 'deposit-credited' ] to deeply equal [ 'deposit-removed' ]
```

**`defect/retry-fresh-nonce`** — the retry re-signs instead of
rebroadcasting identical bytes; S8–S10 catch the double-spend shape:

```
FAIL  S8: a retry after timeout rebroadcasts identical bytes — one transfer
AssertionError: expected '0x9fa4662e0265eae70b2c856f7e11b8af…' to be '0x8b59947bd890190e17aa0dc491c01673…'
```

**`defect/decimals-number`** — fast-check shrinks straight to the
precision cliff (seeded, reproducible):

```
Property failed after 1 tests
{ seed: 20260726, path: "0:0:0:0:1:0:…", endOnFailure: true }
Counterexample: [ …, 53046470415879913n, 0 ]  (shrunk 255 times)
AssertionError: expected 53046470415879912n to be 53046470415879913n
```

## Scenarios

Sixteen scenarios (S1–S16) map test ↔ invariant ↔ custody risk in
[docs/SCENARIOS.md](docs/SCENARIOS.md): confirmation depth (S1–S3),
reorg handling (S4–S7), broadcast idempotency (S8–S10), dropped and
stuck transactions (S11–S12), ERC-20 deposits (S13–S15) and the
reconciliation sweep (S16). Confirmation depth N is explicit policy
everywhere — small in tests so suites stay fast; nothing hardcodes 12.

## How it's built

- **Real node, no mocks** — every integration suite spawns its own
  Anvil (chain id 31337 asserted, or the harness aborts), boots in
  well under a second; reorgs are scripted with `evm_snapshot` /
  `evm_revert` and diverging timestamps ([ADR-0002](docs/adr/0002-reorg-simulation-snapshot-revert.md)).
- **Pure core, I/O at the edge** — the watcher state machine, nonce
  allocator, ERC-20 decoding and reconciler take chain observations as
  data; viem lives only in `src/rpc/` (lint-enforced).
- **Integer minor units only** — every amount is `bigint`; seeded
  fast-check properties pin exactness past 2^53.
- **Deterministic** — Foundry pinned (v1.4.1) and actions SHA-pinned in
  CI, fees and nonces explicit, seeded randomness; the whole suite (59
  tests, 10 files) runs in ~2 seconds, CI in under a minute.
- **No real keys, funds or networks** — signing uses only Anvil's
  well-known dev accounts; gitleaks runs pre-commit and in CI.

## Decisions

- [ADR-0001: Anvil over mocked RPC](docs/adr/0001-anvil-over-mocks.md)
- [ADR-0002: reorg simulation via snapshot/revert](docs/adr/0002-reorg-simulation-snapshot-revert.md)
- [ADR-0003: nonce management and broadcast idempotency](docs/adr/0003-nonce-idempotency.md)
- [ADR-0004: local deploy versus pinned mainnet fork](docs/adr/0004-local-deploy-vs-pinned-fork.md)

## Scope, honestly

A single dev node models the _effect_ of reorgs on an observer, not
fork choice — no competing miners, no gossip, no finality gadget (a
reorg deeper than N raises an alarm; it is not "handled"). Stores are
in-memory; gas strategy stops at minimal fee bumps; the ERC-20 is a
test fixture, not a production contract. See
[docs/PLAN.md](docs/PLAN.md) for the milestone-by-milestone record.

## Siblings

- [bitcoin-chain-testing](https://github.com/qasimmahmood95/bitcoin-chain-testing)
  — same thesis against Bitcoin Core regtest.
- [reconciliation-testing](https://github.com/qasimmahmood95/reconciliation-testing)
  — the property-based reconciliation mindset this repo applies to
  chain state.
