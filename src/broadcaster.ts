// Broadcast intent store: pure decision logic for idempotent
// submission (ADR-0003). The flow the edge must follow:
//
//   1. decide(store, intent)   -> 'rebroadcast' stored bytes, or 'sign'
//   2. reserveNonce(store)     -> allocate from the local allocator
//   3. (edge signs the tx)
//   4. record(store, prepared) -> persist BEFORE the first broadcast
//   5. (edge sends the raw bytes)
//
// A retry re-enters at 1 and gets the identical bytes — it never
// re-signs and never re-reads the pending nonce from the node.
//
// M5 adds deliberate replacement (fee bump): `replace` appends a new
// attempt under the SAME intent and SAME nonce, so whichever attempt
// confirms, the intent completes at most once.

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
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly rawTx: Hex;
  readonly txHash: TxHash;
}

/** One intent, one nonce, one or more signed attempts. The last
 * attempt is the live bytes; earlier ones were superseded by fee
 * bumps. All attempts share the nonce, so the chain can confirm at
 * most one. */
export interface IntentRecord {
  readonly key: IntentKey;
  readonly to: Address;
  readonly amount: Wei;
  readonly nonce: bigint;
  readonly attempts: readonly PreparedTx[];
}

export interface BroadcastStore {
  readonly nonce: NonceState;
  readonly byKey: ReadonlyMap<IntentKey, IntentRecord>;
}

export function createBroadcastStore(nextNonce: bigint): BroadcastStore {
  return { nonce: createNonceState(nextNonce), byKey: new Map() };
}

export type SubmitDecision =
  | { readonly action: 'rebroadcast'; readonly prepared: PreparedTx }
  | { readonly action: 'sign' };

export function latestAttempt(record_: IntentRecord): PreparedTx {
  const last = record_.attempts[record_.attempts.length - 1];
  if (last === undefined) {
    throw new Error(`intent ${record_.key} has no attempts`);
  }
  return last;
}

/** Idempotency gate: a known intent is only ever rebroadcast — always
 * its latest attempt. A key reused with different parameters is a
 * caller bug — paying the stored transfer while reporting success
 * would send customer B's withdrawal to customer A; refused loudly. */
export function decide(
  store: BroadcastStore,
  intent: TransferIntent,
): SubmitDecision {
  const existing = store.byKey.get(intent.key);
  if (existing === undefined) return { action: 'sign' };
  if (existing.to !== intent.to || existing.amount !== intent.amount) {
    throw new Error(
      `intent key ${intent.key} reused with different parameters`,
    );
  }
  return { action: 'rebroadcast', prepared: latestAttempt(existing) };
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
  byKey.set(prepared.key, {
    key: prepared.key,
    to: prepared.to,
    amount: prepared.amount,
    nonce: prepared.nonce,
    attempts: [prepared],
  });
  return { nonce: store.nonce, byKey };
}

/**
 * Record a deliberate replacement (fee bump, S12): the ONLY path that
 * reuses a nonce. Same intent, same nonce, same transfer, strictly
 * higher fees — a replacement under a new nonce could confirm
 * alongside the original (double-spend), and one that changes the
 * transfer is a different intent.
 */
export function replace(
  store: BroadcastStore,
  prepared: PreparedTx,
): BroadcastStore {
  const existing = store.byKey.get(prepared.key);
  if (existing === undefined) {
    throw new Error(`cannot replace unknown intent: ${prepared.key}`);
  }
  if (prepared.nonce !== existing.nonce) {
    throw new Error(
      `replacement must reuse nonce ${existing.nonce}, got ${prepared.nonce}`,
    );
  }
  if (prepared.to !== existing.to || prepared.amount !== existing.amount) {
    throw new Error(
      `replacement changes the transfer for intent ${prepared.key}`,
    );
  }
  const current = latestAttempt(existing);
  if (
    prepared.maxFeePerGas <= current.maxFeePerGas ||
    prepared.maxPriorityFeePerGas <= current.maxPriorityFeePerGas
  ) {
    throw new Error(
      `replacement fees must strictly increase ` +
        `(${current.maxFeePerGas}/${current.maxPriorityFeePerGas} -> ` +
        `${prepared.maxFeePerGas}/${prepared.maxPriorityFeePerGas})`,
    );
  }
  const byKey = new Map(store.byKey);
  byKey.set(prepared.key, {
    ...existing,
    attempts: [...existing.attempts, prepared],
  });
  return { nonce: store.nonce, byKey };
}
