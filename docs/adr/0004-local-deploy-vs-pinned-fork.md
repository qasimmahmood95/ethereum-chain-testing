# 0004: Local deploy versus pinned mainnet fork

Status: accepted (M1)

## Context

Token scenarios (S13–S16) need an ERC-20. Two options: deploy a minimal
fixture on the local dev chain, or fork mainnet at a pinned block and
use a real token (e.g. USDC). A live-RPC dependency in CI is ruled out
by the determinism rule.

## Decision

The default lane deploys a minimal ERC-20 fixture (mint + transfer,
configurable decimals) fresh per suite on local Anvil. A pinned-fork
lane is an optional follow-on, not a milestone: fork block pinned and
its state cached (`actions/cache` keyed on the block, or
`anvil_dumpState` committed if small enough), skipped automatically
when no cache or RPC secret is present.

## Consequences

- CI never depends on a live RPC; runs are reproducible and fast.
- The fixture is test-only by construction (no production contracts);
  6- and 18-decimal variants cover the conversion property.
- Real-token quirks (proxies, blocklists, fee-on-transfer) are not
  exercised in the default lane; that is the pinned-fork lane's job if
  it ever earns its keep.
