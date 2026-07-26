// Pure watcher tests — no node, no I/O. The same state machine is
// driven against real Anvil in the S1–S3 integration suite.

import { describe, expect, it } from 'vitest';
import {
  applyBlock,
  createWatcher,
  creditedBalance,
  depositsInState,
  reorgTo,
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
    expect(events[1]).toMatchObject({ confirmations: 1n });
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

  it('reports an ancestry break (parent-hash mismatch) and leaves state untouched', () => {
    let state = createWatcher({ confirmationDepth: 2 });
    state = applyBlock(state, block(1n)).state;
    const result = applyBlock(state, block(2n, [], 'b'));
    expect(result.outcome).toBe('ancestry-break');
    expect(result.events).toEqual([]);
    expect(result.state).toBe(state);
  });

  it('refuses duplicate deposit observations', () => {
    let state = createWatcher({ confirmationDepth: 3 });
    state = applyBlock(state, block(1n, [deposit(1, 1n)])).state;
    expect(() => applyBlock(state, block(2n, [deposit(1, 1n)]))).toThrow(
      /duplicate/,
    );
  });
});

describe('reorgTo (pure)', () => {
  /** Replacement block attaching lineage b onto a lineage-a ancestor. */
  function attach(
    height: bigint,
    deposits: readonly DepositObservation[] = [],
  ): BlockObservation {
    return {
      header: {
        height,
        hash: blockHash(`0x${hashBody(height, 'b')}`),
        parentHash: blockHash(`0x${hashBody(height - 1n, 'a')}`),
      },
      deposits,
    };
  }

  /** Linear lineage-a chain: heights 1..n, deposit at `depositAt`. */
  function build(
    depth: number,
    upTo: bigint,
    depositAt?: bigint,
  ): WatcherState {
    let state = createWatcher({ confirmationDepth: depth });
    for (let h = 1n; h <= upTo; h++) {
      state = applyBlock(
        state,
        block(h, h === depositAt ? [deposit(1, 500n)] : []),
      ).state;
    }
    return state;
  }

  it('removes deposits above the ancestor, keeps those at or below it', () => {
    // Deposits at heights 2 (kept) and 4 (removed); ancestor = 3.
    let state = createWatcher({ confirmationDepth: 10 });
    state = applyBlock(state, block(1n)).state;
    state = applyBlock(state, block(2n, [deposit(1, 100n)])).state;
    state = applyBlock(state, block(3n)).state;
    state = applyBlock(state, block(4n, [deposit(2, 7n)])).state;

    const { state: next, events } = reorgTo(state, [
      attach(4n),
      block(5n, [], 'b'),
    ]);
    expect(events.map((e) => e.type)).toEqual(['deposit-removed']);
    expect(next.deposits.size).toBe(1);
    expect(depositsInState(next, 'seen')[0]?.inclusionHeight).toBe(2n);
  });

  it('keeps a deposit exactly at the ancestor height — including its credit', () => {
    // depth 2: deposit at height 3 credits at height 4. Ancestor = 3,
    // so the deposit's inclusion block stays canonical.
    const credited = build(2, 4n, 3n);
    const creditedReorg = reorgTo(credited, [attach(4n), block(5n, [], 'b')]);
    expect(creditedReorg.events).toEqual([]);
    expect(depositsInState(creditedReorg.state, 'credited')).toHaveLength(1);
    expect(
      depositsInState(creditedReorg.state, 'credited')[0]?.inclusionHeight,
    ).toBe(3n);

    // Same shape while still merely seen (depth 10): survives as seen.
    const seen = build(10, 4n, 3n);
    const seenReorg = reorgTo(seen, [attach(4n), block(5n, [], 'b')]);
    expect(seenReorg.events).toEqual([]);
    expect(depositsInState(seenReorg.state, 'seen')).toHaveLength(1);
  });

  it('refuses a replacement that does not diverge (ancestor chosen too deep)', () => {
    const state = build(2, 3n);
    expect(() => reorgTo(state, [block(2n), block(3n), block(4n)])).toThrow(
      /does not diverge/,
    );
  });

  it('raises an alarm when the removed deposit was already credited (S7)', () => {
    const state = build(2, 4n, 3n); // credited at height 4
    expect(depositsInState(state, 'credited')).toHaveLength(1);

    const { state: next, events } = reorgTo(state, [
      attach(3n),
      block(4n, [], 'b'),
      block(5n, [], 'b'),
    ]);
    expect(events.map((e) => e.type)).toEqual(['deposit-removed', 'alarm']);
    expect(next.deposits.size).toBe(0);
  });

  it('replays the replacement chain: re-included deposits credit from the new height', () => {
    const state = build(3, 3n, 2n); // seen at 2, one conf short of credit
    const { state: next, events } = reorgTo(state, [
      attach(2n),
      block(3n, [deposit(1, 500n)], 'b'), // re-included one block later
      block(4n, [], 'b'),
    ]);
    expect(events.map((e) => e.type)).toEqual([
      'deposit-removed',
      'deposit-seen',
    ]);
    // New inclusion at 3, tip 4: only 2 of 3 confirmations — not credited.
    expect(depositsInState(next, 'credited')).toHaveLength(0);

    const { events: creditEvents } = applyBlock(next, block(5n, [], 'b'));
    expect(creditEvents).toEqual([
      expect.objectContaining({
        type: 'deposit-credited',
        confirmations: 3n,
      }),
    ]);
  });

  it('drops all orphaned headers — state never mixes two forks (S6)', () => {
    const state = build(10, 3n);
    const { state: next } = reorgTo(state, [
      attach(2n),
      block(3n, [], 'b'),
      block(4n, [], 'b'),
    ]);
    expect(next.headers.get(1n)).toEqual(state.headers.get(1n));
    for (const h of [2n, 3n, 4n]) {
      expect(next.headers.get(h)?.hash).toBe(
        blockHash(`0x${hashBody(h, 'b')}`),
      );
    }
    expect(next.tip?.height).toBe(4n);
  });

  it('refuses a reorg deeper than observed history', () => {
    const state = build(2, 3n);
    expect(() =>
      reorgTo(state, [block(1n, [], 'b'), block(2n, [], 'b')]),
    ).toThrow(/deeper than observed history|does not attach/);
  });

  it('refuses a replacement that does not attach to the ancestor by parent hash', () => {
    const state = build(2, 3n);
    // Height says it attaches at 2, but the parent hash is lineage b.
    expect(() => reorgTo(state, [block(3n, [], 'b')])).toThrow(
      /does not attach/,
    );
  });

  it('refuses a replacement that is not strictly longer than the tip', () => {
    const state = build(2, 3n);
    expect(() => reorgTo(state, [attach(3n)])).toThrow(/strictly longer/);
  });

  it('refuses a non-contiguous replacement chain', () => {
    const state = build(2, 3n);
    expect(() => reorgTo(state, [attach(2n), block(4n, [], 'b')])).toThrow(
      /not contiguous/,
    );
  });
});
