# 0003: Nonce management and broadcast idempotency

Status: accepted; implemented in M4

## Context

The classic custody double-spend: broadcast times out, the caller
retries, and the retry re-signs with a fresh nonce read from the node —
now two live transactions move the same funds. The node's
`getTransactionCount('pending')` is not a reliable allocator: it shifts
under eviction, races concurrent submits, and knows nothing about
intents.

## Decision

- Every transfer is an _intent_ with an idempotency key; the store is
  keyed by it.
- Flow: allocate nonce from a local monotonic allocator, sign, persist
  `{intent, nonce, rawTx, hash}` **before** first broadcast, then send.
- A retry looks up the stored raw tx and rebroadcasts the identical
  bytes. It never re-signs and never re-reads the pending nonce.
- Concurrent submits of one intent serialize on the submitter's
  in-flight map and return the same hash; the store's duplicate-intent
  refusal backstops it (reject, never converge on a double-sign).
- The local allocator is the source of truth for pending nonces; the
  chain is consulted only to initialize it and to confirm inclusion.

## Consequences

- A retry after timeout cannot double-broadcast, reuse a nonce for a
  different intent, or double-spend (S8–S10).
- Deliberate replacement (fee bump, M5) is the _only_ path that reuses
  a nonce, recorded as superseding the original under the same intent.
- Cost: the store must be persisted before any bytes hit the wire;
  in-memory here (out of scope: durable storage), but the ordering
  invariant is what the tests pin down.
- A failure between nonce reservation and record would leave a gap
  that freezes every later withdrawal; the sender poisons itself on
  that path and refuses further submits rather than continuing
  silently.
