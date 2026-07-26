// Local monotonic nonce allocator — the source of truth for pending
// nonces (ADR-0003). Pure: allocation is a state transition, not a
// node query. The node's getTransactionCount('pending') shifts under
// eviction and races concurrent submits; this never does.

export interface NonceState {
  /** The next nonce to hand out. */
  readonly next: bigint;
}

export function createNonceState(next: bigint): NonceState {
  if (next < 0n) {
    throw new Error(`nonce must be non-negative, got ${next}`);
  }
  return { next };
}

export function allocateNonce(state: NonceState): {
  readonly state: NonceState;
  readonly nonce: bigint;
} {
  return { state: { next: state.next + 1n }, nonce: state.next };
}
