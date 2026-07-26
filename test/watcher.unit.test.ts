// Pure watcher tests — no node, no I/O. The same state machine is
// driven against real Anvil in the S1–S3 integration suite.

import { describe, expect, it } from 'vitest';
import {
  applyBlock,
  createWatcher,
  creditedBalance,
  depositsInState,
  type WatcherState,
} from '../src/watcher.js';
import {
  address,
  blockHash,
  txHash,
  wei,
  type BlockObservation,
  type DepositObservation,
} from '../src/types.js';

const CUSTODY = address(`0x${'11'.repeat(20)}`);

function header(height: bigint, lineage = 'a') {
  return {
    height,
    hash: blockHash(`0x${hashBody(height, lineage)}`),
    parentHash: blockHash(`0x${hashBody(height - 1n, lineage)}`),
  };
}

function hashBody(height: bigint, lineage: string): string {
  const tag = `${lineage.charCodeAt(0).toString(16)}${height}`;
  return tag.padStart(64, '0');
}

function block(
  height: bigint,
  deposits: readonly DepositObservation[] = [],
  lineage = 'a',
): BlockObservation {
  return { header: header(height, lineage), deposits };
}

function deposit(seed: number, amount: bigint): DepositObservation {
  return {
    txHash: txHash(`0x${seed.toString(16).padStart(64, '0')}`),
    to: CUSTODY,
    amount: wei(amount),
  };
}

function applyAll(
  state: WatcherState,
  blocks: readonly BlockObservation[],
): { state: WatcherState; types: string[] } {
  const types: string[] = [];
  for (const b of blocks) {
    const result = applyBlock(state, b);
    state = result.state;
    types.push(...result.events.map((e) => e.type));
  }
  return { state, types };
}

describe('watcher (pure)', () => {
  it('rejects a confirmation depth below 1 or non-integer', () => {
    expect(() => createWatcher({ confirmationDepth: 0 })).toThrow();
    expect(() => createWatcher({ confirmationDepth: 2.5 })).toThrow();
  });

  it('credits at exactly depth N and never below, for several depths', () => {
    for (const depth of [1, 2, 5, 8]) {
      let state = createWatcher({ confirmationDepth: depth });
      state = applyBlock(state, block(1n, [deposit(1, 1000n)])).state;

      // Inclusion at height 1 means confirmations == current height.
      // Mine up to N-1 confirmations: still seen, never credited.
      for (let h = 2n; h < BigInt(depth); h++) {
        const { state: next, events } = applyBlock(state, block(h));
        state = next;
        expect(events, `depth ${depth}, height ${h}`).toEqual([]);
      }
      expect(depositsInState(state, 'seen')).toHaveLength(depth > 1 ? 1 : 0);

      if (depth > 1) {
        // The N-th confirmation credits.
        const { state: credited, events } = applyBlock(
          state,
          block(BigInt(depth)),
        );
        state = credited;
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          type: 'deposit-credited',
          confirmations: BigInt(depth),
        });
      }
      expect(depositsInState(state, 'credited')).toHaveLength(1);
    }
  });

  it('credits exactly once — later blocks emit no second credit', () => {
    const state = createWatcher({ confirmationDepth: 2 });
    const run = applyAll(state, [
      block(1n, [deposit(1, 7n)]),
      block(2n),
      block(3n),
      block(4n),
    ]);
    expect(run.types).toEqual(['deposit-seen', 'deposit-credited']);
  });

  it('a depth-1 policy credits in the inclusion block, seen then credited', () => {
    const state = createWatcher({ confirmationDepth: 1 });
    const { events } = applyBlock(state, block(1n, [deposit(1, 5n)]));
    expect(events.map((e) => e.type)).toEqual([
      'deposit-seen',
      'deposit-credited',
    ]);
  });

  it('preserves amounts exactly past 2^53 wei', () => {
    const amount = 2n ** 53n + 1n;
    let state = createWatcher({ confirmationDepth: 1 });
    state = applyBlock(state, block(1n, [deposit(1, amount)])).state;
    expect(creditedBalance(state, CUSTODY)).toBe(amount);
  });

  it('sums credited balances per address, excluding merely-seen deposits', () => {
    let state = createWatcher({ confirmationDepth: 2 });
    state = applyBlock(state, block(1n, [deposit(1, 100n)])).state;
    state = applyBlock(state, block(2n, [deposit(2, 10n)])).state;
    // deposit 1 now credited (2 confs), deposit 2 only seen.
    expect(creditedBalance(state, CUSTODY)).toBe(100n);
  });

  it('refuses non-contiguous heights', () => {
    let state = createWatcher({ confirmationDepth: 2 });
    state = applyBlock(state, block(1n)).state;
    expect(() => applyBlock(state, block(3n))).toThrow(/non-contiguous/);
  });

  it('refuses an ancestry break (parent-hash mismatch) loudly', () => {
    let state = createWatcher({ confirmationDepth: 2 });
    state = applyBlock(state, block(1n)).state;
    expect(() => applyBlock(state, block(2n, [], 'b'))).toThrow(
      /ancestry break/,
    );
  });

  it('refuses duplicate deposit observations', () => {
    let state = createWatcher({ confirmationDepth: 3 });
    state = applyBlock(state, block(1n, [deposit(1, 1n)])).state;
    expect(() => applyBlock(state, block(2n, [deposit(1, 1n)]))).toThrow(
      /duplicate/,
    );
  });
});
