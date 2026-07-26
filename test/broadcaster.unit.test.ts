// Pure tests for the nonce allocator and broadcast intent store.

import { describe, expect, it } from 'vitest';
import { allocateNonce, createNonceState } from '../src/nonce.js';
import {
  createBroadcastStore,
  decide,
  latestAttempt,
  record,
  replace,
  reserveNonce,
  type PreparedTx,
} from '../src/broadcaster.js';
import { address, intentKey, txHash, wei, type Hex } from '../src/types.js';

const TO = address(`0x${'33'.repeat(20)}`);
const AMOUNT = wei(1_000n);

function prepared(
  key: string,
  nonce: bigint,
  fees: { max: bigint; prio: bigint } = { max: 10n, prio: 1n },
): PreparedTx {
  return {
    key: intentKey(key),
    to: TO,
    amount: AMOUNT,
    nonce,
    maxFeePerGas: fees.max,
    maxPriorityFeePerGas: fees.prio,
    rawTx: `0x02${nonce.toString(16)}${fees.max.toString(16)}` as Hex,
    txHash: txHash(
      `0x${(nonce * 1000n + fees.max).toString(16).padStart(64, '0')}`,
    ),
  };
}

function intentOf(key: string) {
  return { key: intentKey(key), to: TO, amount: AMOUNT };
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
    expect(decide(store, intentOf('wd-1'))).toEqual({ action: 'sign' });

    const reserved = reserveNonce(store);
    store = record(reserved.store, prepared('wd-1', reserved.nonce));

    const decision = decide(store, intentOf('wd-1'));
    expect(decision.action).toBe('rebroadcast');
    if (decision.action === 'rebroadcast') {
      // Identical bytes, identical hash — never re-signed.
      expect(decision.prepared.rawTx).toBe(prepared('wd-1', 0n).rawTx);
      expect(decision.prepared.txHash).toBe(prepared('wd-1', 0n).txHash);
    }
  });

  it('refuses an intent key reused with different parameters', () => {
    let store = createBroadcastStore(0n);
    const reserved = reserveNonce(store);
    store = record(reserved.store, prepared('wd-1', reserved.nonce));
    expect(() =>
      decide(store, { ...intentOf('wd-1'), amount: wei(999n) }),
    ).toThrow(/different parameters/);
    expect(() =>
      decide(store, {
        ...intentOf('wd-1'),
        to: address(`0x${'44'.repeat(20)}`),
      }),
    ).toThrow(/different parameters/);
  });

  it('refuses to record a nonce below the allocator floor', () => {
    const store = createBroadcastStore(3n);
    expect(() => record(store, prepared('wd-1', 1n))).toThrow(/never reserved/);
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

describe('replacement / fee bump (pure, S12)', () => {
  function recorded(): { store: ReturnType<typeof createBroadcastStore> } {
    let store = createBroadcastStore(0n);
    const a = reserveNonce(store);
    store = record(a.store, prepared('wd-1', a.nonce));
    return { store };
  }

  it('a valid bump supersedes: same intent, same nonce, higher fees', () => {
    let { store } = recorded();
    const bump = prepared('wd-1', 0n, { max: 20n, prio: 2n });
    store = replace(store, bump);

    const decision = decide(store, intentOf('wd-1'));
    expect(decision.action).toBe('rebroadcast');
    if (decision.action === 'rebroadcast') {
      // The latest attempt (the bump) is what rebroadcasts now.
      expect(decision.prepared.txHash).toBe(bump.txHash);
    }
    const rec = store.byKey.get(intentKey('wd-1'));
    expect(rec?.attempts).toHaveLength(2);
    expect(latestAttempt(rec!).maxFeePerGas).toBe(20n);
  });

  it('a second bump must exceed the FIRST bump, and becomes the live attempt', () => {
    let { store } = recorded();
    store = replace(store, prepared('wd-1', 0n, { max: 20n, prio: 2n }));
    // Priced between the original and bump 1: going backwards — refused.
    expect(() =>
      replace(store, prepared('wd-1', 0n, { max: 15n, prio: 3n })),
    ).toThrow(/strictly increase/);

    const bump2 = prepared('wd-1', 0n, { max: 30n, prio: 3n });
    store = replace(store, bump2);
    const decision = decide(store, intentOf('wd-1'));
    if (decision.action === 'rebroadcast') {
      expect(decision.prepared.txHash).toBe(bump2.txHash);
    } else {
      expect.unreachable('recorded intent must rebroadcast');
    }
    expect(store.byKey.get(intentKey('wd-1'))?.attempts).toHaveLength(3);
  });

  it('refuses a replacement under a different nonce (double-spend path)', () => {
    const { store } = recorded();
    expect(() =>
      replace(store, prepared('wd-1', 1n, { max: 20n, prio: 2n })),
    ).toThrow(/must reuse nonce/);
  });

  it('refuses a replacement that does not strictly raise both fees', () => {
    const { store } = recorded();
    expect(() =>
      replace(store, prepared('wd-1', 0n, { max: 10n, prio: 2n })),
    ).toThrow(/strictly increase/);
    expect(() =>
      replace(store, prepared('wd-1', 0n, { max: 20n, prio: 1n })),
    ).toThrow(/strictly increase/);
  });

  it('refuses a replacement that changes the transfer', () => {
    const { store } = recorded();
    const wrong = {
      ...prepared('wd-1', 0n, { max: 20n, prio: 2n }),
      amount: wei(999n),
    };
    expect(() => replace(store, wrong)).toThrow(/changes the transfer/);
  });

  it('refuses to replace an unknown intent', () => {
    const store = createBroadcastStore(0n);
    expect(() =>
      replace(store, prepared('wd-x', 0n, { max: 20n, prio: 2n })),
    ).toThrow(/unknown intent/);
  });
});
