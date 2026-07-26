// Pure tests for the nonce allocator and broadcast intent store.

import { describe, expect, it } from 'vitest';
import { allocateNonce, createNonceState } from '../src/nonce.js';
import {
  createBroadcastStore,
  decide,
  record,
  reserveNonce,
  type PreparedTx,
} from '../src/broadcaster.js';
import { intentKey, txHash, type Hex } from '../src/types.js';

function prepared(key: string, nonce: bigint): PreparedTx {
  return {
    key: intentKey(key),
    nonce,
    rawTx: `0x02${nonce.toString(16).padStart(4, '0')}` as Hex,
    txHash: txHash(`0x${nonce.toString(16).padStart(64, '0')}`),
  };
}

describe('nonce allocator (pure)', () => {
  it('is strictly monotonic and gapless', () => {
    let state = createNonceState(7n);
    const seen: bigint[] = [];
    for (let i = 0; i < 5; i++) {
      const result = allocateNonce(state);
      state = result.state;
      seen.push(result.nonce);
    }
    expect(seen).toEqual([7n, 8n, 9n, 10n, 11n]);
  });

  it('rejects a negative starting nonce', () => {
    expect(() => createNonceState(-1n)).toThrow(/non-negative/);
  });
});

describe('broadcast store (pure)', () => {
  it('an unknown intent signs; a recorded intent only ever rebroadcasts', () => {
    let store = createBroadcastStore(0n);
    const key = intentKey('wd-1');
    expect(decide(store, key)).toEqual({ action: 'sign' });

    const reserved = reserveNonce(store);
    store = record(reserved.store, prepared('wd-1', reserved.nonce));

    const decision = decide(store, key);
    expect(decision.action).toBe('rebroadcast');
    if (decision.action === 'rebroadcast') {
      // Identical bytes, identical hash — never re-signed.
      expect(decision.prepared.rawTx).toBe(prepared('wd-1', 0n).rawTx);
      expect(decision.prepared.txHash).toBe(prepared('wd-1', 0n).txHash);
    }
  });

  it('refuses to record the same intent twice', () => {
    let store = createBroadcastStore(0n);
    const a = reserveNonce(store);
    store = record(a.store, prepared('wd-1', a.nonce));
    const b = reserveNonce(store);
    expect(() => record(b.store, prepared('wd-1', b.nonce))).toThrow(
      /already recorded/,
    );
  });

  it('refuses to record a nonce that was never reserved', () => {
    const store = createBroadcastStore(3n);
    expect(() => record(store, prepared('wd-1', 5n))).toThrow(/never reserved/);
  });

  it('refuses nonce reuse across intents', () => {
    let store = createBroadcastStore(0n);
    const a = reserveNonce(store);
    store = record(a.store, prepared('wd-1', a.nonce));
    // A second intent trying to bind the same nonce is a double-spend
    // path — reserving properly gives a fresh nonce.
    expect(() => record(store, prepared('wd-2', a.nonce))).toThrow(
      /already bound/,
    );
  });
});
