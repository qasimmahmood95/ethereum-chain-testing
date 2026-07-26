# ethereum-chain-testing

[![ci](https://github.com/qasimmahmood95/ethereum-chain-testing/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/qasimmahmood95/ethereum-chain-testing/actions/workflows/ci.yml)

Integration tests for the custody/chain boundary on Ethereum. A small
watcher/broadcaster library is exercised against a real local node
(Anvil), with deterministic reorgs via snapshot/revert. The thesis:
custody software watches, broadcasts and confirms against the chain,
and that boundary — reorgs, confirmation depth, nonce reuse, dropped
transactions — is where the hard QA lives.

> **Stopgap README.** The full write-up lands with the final milestone,
> once the planted-defect branches exist and their red CI runs can be
> quoted here. Until then: the plan and scenario table below are the
> best map of the repo.

## Status

- **M1 landed**: strict-TS scaffold and an Anvil harness that spawns a
  real node per suite (asserts chain id 31337, opt-in snapshot/revert
  reset per test), green in CI in under a minute.
- **Next, M2**: the deposit watcher — seen at 1 confirmation, credited
  at depth N, as pure logic fed by chain observations.
- Roadmap: [docs/PLAN.md](docs/PLAN.md) · Scenario ↔ invariant ↔
  custody-risk table: [docs/SCENARIOS.md](docs/SCENARIOS.md)

## Running locally

Prerequisites: Node 22+, [Foundry](https://getfoundry.sh) (`anvil` on
PATH). No keys, no funds, no live networks — the harness refuses any
chain other than Anvil's dev chain (id 31337).

```
npm ci
npm test
```

`npm run lint`, `npm run typecheck` and `npm run build` complete the
CI gate.

## Decisions

- [ADR-0001: Anvil over mocked RPC](docs/adr/0001-anvil-over-mocks.md)
- [ADR-0002: reorg simulation via snapshot/revert](docs/adr/0002-reorg-simulation-snapshot-revert.md)
- [ADR-0003: nonce management and broadcast idempotency](docs/adr/0003-nonce-idempotency.md)
- [ADR-0004: local deploy versus pinned mainnet fork](docs/adr/0004-local-deploy-vs-pinned-fork.md)

## Siblings

- [bitcoin-chain-testing](https://github.com/qasimmahmood95/bitcoin-chain-testing)
  — same thesis against Bitcoin Core regtest.
- [reconciliation-testing](https://github.com/qasimmahmood95/reconciliation-testing)
  — the property-based reconciliation mindset this repo applies to
  chain state.
