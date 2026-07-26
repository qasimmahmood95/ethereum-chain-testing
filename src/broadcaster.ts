// Broadcast intent store: pure decision logic for idempotent
// submission (ADR-0003). The flow the edge must follow:
//
//   1. decide(store, key)      -> 'rebroadcast' stored bytes, or 'sign'
//   2. reserveNonce(store)     -> allocate from the local allocator
//   3. (edge signs the tx)
//   4. record(store, prepared) -> persist BEFORE the first broadcast
//   5. (edge sends the raw bytes)
//
// A retry re-enters at 1 and gets the identical bytes — it never
// re-signs and never re-reads the pending nonce from the node.

import { allocateNonce, createNonceState, type NonceState } from './nonce.js';
import type { Address, Hex, IntentKey, TxHash, Wei } from './types.js';

/** A transfer the custody system intends to make, exactly once. */
export interface TransferIntent {
  readonly key: IntentKey;
  readonly to: Address;
  readonly amount: Wei;
}

/** A signed tx bound to an intent, persisted before first broadcast.
 * Carries the intent's parameters so a reused key with different
 * to/amount is caught instead of silently paying the wrong transfer. */
export interface PreparedTx {
  readonly key: IntentKey;
  readonly to: Address;
  readonly amount: Wei;
  readonly nonce: bigint;
  readonly rawTx: Hex;
  readonly txHash: TxHash;
}

export interface BroadcastStore {
  readonly nonce: NonceState;
  readonly byKey: ReadonlyMap<IntentKey, PreparedTx>;
}

export function createBroadcastStore(nextNonce: bigint): BroadcastStore {
  return { nonce: createNonceState(nextNonce), byKey: new Map() };
}

export type SubmitDecision =
  | { readonly action: 'rebroadcast'; readonly prepared: PreparedTx }
  | { readonly action: 'sign' };

/** Idempotency gate: a known intent is only ever rebroadcast. A key
 * reused with different parameters is a caller bug — paying the stored
 * transfer while reporting success would send customer B's withdrawal
 * to customer A, so it is refused loudly. */
export function decide(
  store: BroadcastStore,
  intent: TransferIntent,
): SubmitDecision {
  const prepared = store.byKey.get(intent.key);
  if (prepared === undefined) return { action: 'sign' };
  if (prepared.to !== intent.to || prepared.amount !== intent.amount) {
    throw new Error(
      `intent key ${intent.key} reused with different parameters`,
    );
  }
  return { action: 'rebroadcast', prepared };
}

export function reserveNonce(store: BroadcastStore): {
  readonly store: BroadcastStore;
  readonly nonce: bigint;
} {
  const { state, nonce } = allocateNonce(store.nonce);
  return { store: { nonce: state, byKey: store.byKey }, nonce };
}

/**
 * Persist a signed tx under its intent key. Must happen before the
 * bytes first hit the wire. Refuses double-recording an intent and
 * nonce reuse across intents — either would be a double-spend path.
 */
export function record(
  store: BroadcastStore,
  prepared: PreparedTx,
): BroadcastStore {
  if (store.byKey.has(prepared.key)) {
    throw new Error(`intent already recorded: ${prepared.key}`);
  }
  if (
    prepared.nonce >= store.nonce.next ||
    prepared.nonce < store.nonce.floor
  ) {
    throw new Error(
      `nonce ${prepared.nonce} was never reserved ` +
        `(allocator owns [${store.nonce.floor}, ${store.nonce.next}))`,
    );
  }
  for (const existing of store.byKey.values()) {
    if (existing.nonce === prepared.nonce) {
      throw new Error(
        `nonce ${prepared.nonce} already bound to intent ${existing.key}`,
      );
    }
  }
  const byKey = new Map(store.byKey);
  byKey.set(prepared.key, prepared);
  return { nonce: store.nonce, byKey };
}
