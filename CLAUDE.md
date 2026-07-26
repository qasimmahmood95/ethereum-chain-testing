# CLAUDE.md

Public portfolio repository: integration tests for the custody/chain
boundary on Ethereum. A small watcher/broadcaster library is exercised
against a real local node (Anvil), with deterministic reorgs via
snapshot/revert, planted-defect branches, and the red CI runs linked from
the README. Sibling of bitcoin-chain-testing (same thesis: custody
watches, broadcasts and confirms against the chain, and that boundary is
where the hard QA lives) with the property-based mindset of
reconciliation-testing.

## Scope

- Test code and harness only. The library under test (deposit watcher,
  confirmation-depth tracking, broadcaster and nonce manager, ERC-20 log
  decoding, reconciler) exists to be tested; it is not a product.
- System under test runs against Anvil (Foundry), spawned locally by the
  harness and in CI. Optionally a pinned, cached mainnet fork; never a
  live RPC dependency in CI.
- No production contracts. `contracts/` holds a minimal ERC-20 fixture
  deployed for tests only; standard/well-known contracts may be used on
  the pinned fork.
- If a feature does not serve a scenario in `docs/SCENARIOS.md`, cut it.

## Hard rules

1. No real keys, no real funds, no live networks. Signing uses only
   Anvil's well-known dev accounts. The harness asserts chain id 31337
   before doing anything and aborts otherwise. gitleaks runs pre-commit
   and in CI as a backstop; there must never be anything for it to find.
2. Integer minor units only. All amounts are `bigint` wei or token minor
   units. `number` never holds an amount, in the library, harness or
   tests.
3. Core logic is pure; I/O lives at the edge. The watcher state machine,
   nonce allocator and reconciler take chain observations as data and
   return decisions as data. viem and every RPC call live only in
   `src/rpc/`. Integration tests drive the whole stack against Anvil;
   the core is also testable without a node.
4. Deterministic everywhere. Foundry version pinned in CI, fork block
   pinned and cached when fork mode is used, randomness seeded, time and
   block heights explicit inputs. A failure must reproduce byte for byte
   in CI and locally (Windows dev machine and Linux CI both supported).
5. Confirmation depth N is policy, passed in explicitly. Tests exercise
   the N-1/N boundary; nothing hardcodes "12".

## Conventions

- TypeScript, `"strict": true`, ESM (`"type": "module"`), Node LTS.
- viem for all chain access (including its test-client actions for
  Anvil's `evm_*`/`anvil_*` methods); vitest for tests; fast-check where
  the input space warrants it (unit conversion, log slicing), scripted
  deterministic scenarios for chain behaviour.
- eslint and prettier, enforced in CI.
- Conventional Commits; small, reviewable commits.
- One PR per milestone (see `docs/PLAN.md`).
- ADRs in `docs/adr/NNNN-title.md`, one page each. Required set:
  Anvil over mocks, reorg simulation via snapshot/revert, the
  nonce-idempotency design, local-deploy versus pinned-fork.
- CI on GitHub Actions (ubuntu, foundry-toolchain pinned), runs on every
  branch push so `defect/*` runs are visible; total wall time under
  5 minutes.

## Planted-defect branches

Long-lived branches named `defect/<slug>`, each exactly one plausible
commit on top of `main` — written to read like a sensible change, with a
commit message that argues for it. CI on each branch must fail on the
intended scenario and nothing else. The README on `main` quotes the
failures and links the red runs. Never merge defect branches; rebase
them when `main` moves.

## Workflow

- Before each milestone PR: a code-review subagent reviews the full diff
  for correctness, invariant coverage and convention adherence; findings
  are addressed before the PR opens.
- After each milestone lands and after defect branches are rebased: a
  verification subagent runs from a clean checkout — install, lint,
  typecheck, build, full suite against Anvil on `main` (must pass), then
  each `defect/*` branch (must fail on the intended test, especially the
  reorg un-credit and nonce-idempotency tests). A defect branch that
  passes, or fails on the wrong test, is a bug in the defect branch.

## Commands

```
npm ci            # install (requires foundry: anvil on PATH)
npm run lint      # eslint + prettier check
npm run typecheck # tsc --noEmit
npm test          # vitest run; harness spawns and tears down Anvil
npm run build     # tsc emit
```

## Layout

```
src/               library under test: watcher, broadcaster, nonce
                   allocator, erc20 decoding, reconcile (pure logic)
src/rpc/           thin viem adapter — the only module that talks to a node
contracts/         minimal ERC-20 test fixture (source + built artifact)
test/              integration scenarios (S1..S16) and property tests
test/harness/      anvil lifecycle, reorg/mining/mempool helpers
docs/adr/          architecture decision records
docs/PLAN.md       milestone plan
docs/SCENARIOS.md  scenario ↔ invariant ↔ custody-risk table
```
