// S4–S7 (docs/SCENARIOS.md): deterministic reorgs via snapshot/revert
// (ADR-0002). The headline test is S4: a deposit below confirmation
// depth un-credits when its inclusion block leaves the canonical chain.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startAnvil,
  useSnapshotReset,
  type AnvilInstance,
} from './harness/anvil.js';
import { DEV_ACCOUNT_0, sendEth } from './harness/accounts.js';
import { beginReorg } from './harness/reorg.js';
import { syncToTip } from './harness/sync.js';
import { createChainReader, type ChainReader } from '../src/rpc/adapter.js';
import {
  createWatcher,
  creditedBalance,
  depositsInState,
  type WatcherState,
} from '../src/watcher.js';
import { address, type WatcherEvent } from '../src/types.js';

const DEPTH = 5;
const CUSTODY = address(`0x${'22'.repeat(20)}`);
const AMOUNT = 987_654_321_987_654_321_987n;

describe('S4–S7: reorg handling against Anvil', () => {
  let anvil: AnvilInstance;
  let reader: ChainReader;

  beforeAll(async () => {
    anvil = await startAnvil();
    await anvil.testClient.setAutomine(false);
    reader = createChainReader(anvil.rpcUrl);
  });

  afterAll(async () => {
    await anvil?.stop();
  });

  useSnapshotReset(() => anvil);

  const mine = (blocks: number) => anvil.testClient.mine({ blocks });

  it('S4: a deposit below depth un-credits when reorged out (the headline)', async () => {
    const baseline = await reader.getTipHeight();
    let state: WatcherState = createWatcher({ confirmationDepth: DEPTH });
    const sync = async (): Promise<readonly WatcherEvent[]> => {
      const r = await syncToTip(reader, state, baseline, [CUSTODY]);
      state = r.state;
      return r.events;
    };

    const reorg = await beginReorg(anvil); // fork point: baseline
    await sendEth(anvil.rpcUrl, { to: CUSTODY, valueWei: AMOUNT });
    await mine(1); // inclusion at baseline+1
    await mine(1); // 2 confirmations — still below N
    const before = await sync();
    expect(before.map((e) => e.type)).toEqual(['deposit-seen']);
    const oldTip = baseline + 2n;

    // Replacement branch without the tx, longer than the original.
    await reorg.revertAndReplace(async () => {
      await mine(4);
    });

    const after = await sync();
    expect(after.map((e) => e.type)).toEqual(['deposit-removed']);
    expect(state.deposits.size).toBe(0);
    expect(creditedBalance(state, CUSTODY)).toBe(0n);

    // The head passes the old height and beyond depth N — the vanished
    // deposit must never come back or credit.
    await mine(DEPTH);
    const later = await sync();
    expect(later).toEqual([]);
    expect(state.tip?.height).toBeGreaterThan(oldTip + BigInt(DEPTH));
    expect(creditedBalance(state, CUSTODY)).toBe(0n);

    // State follows the replacement chain, not the orphaned one.
    const chainHeader = await reader.getHeader(baseline + 1n);
    expect(state.headers.get(baseline + 1n)?.hash).toBe(chainHeader.hash);
  });

  it('S5: the same tx re-included at a new height counts confirmations from there', async () => {
    const baseline = await reader.getTipHeight();
    let state: WatcherState = createWatcher({ confirmationDepth: DEPTH });
    const sync = async (): Promise<readonly WatcherEvent[]> => {
      const r = await syncToTip(reader, state, baseline, [CUSTODY]);
      state = r.state;
      return r.events;
    };

    // Pin nonce + fees so the re-sent tx is byte-identical (same hash).
    const nonce = await anvil.publicClient.getTransactionCount({
      address: DEV_ACCOUNT_0,
    });
    const pinned = {
      to: CUSTODY as `0x${string}`,
      valueWei: AMOUNT,
      nonce,
      maxFeePerGas: 10_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    };

    const reorg = await beginReorg(anvil);
    const originalHash = await sendEth(anvil.rpcUrl, pinned);
    await mine(1); // inclusion at baseline+1
    await mine(1);
    await sync();
    expect(depositsInState(state, 'seen')[0]?.inclusionHeight).toBe(
      baseline + 1n,
    );

    let replayHash: `0x${string}` | undefined;
    await reorg.revertAndReplace(async () => {
      await mine(2); // two empty blocks first
      replayHash = await sendEth(anvil.rpcUrl, pinned);
      await mine(1); // re-inclusion at baseline+3
      await mine(3); // new tip baseline+6: re-inclusion has N-1 confs
    });
    expect(replayHash).toBe(originalHash);

    const events = await sync();
    expect(events.map((e) => e.type)).toEqual([
      'deposit-removed',
      'deposit-seen',
    ]);
    const fresh = depositsInState(state, 'seen')[0];
    expect(fresh?.inclusionHeight).toBe(baseline + 3n);
    // N-1 confirmations counted from the NEW inclusion block: no credit.
    expect(depositsInState(state, 'credited')).toHaveLength(0);

    await mine(1);
    const credited = await sync();
    expect(credited).toHaveLength(1);
    expect(credited[0]).toMatchObject({
      type: 'deposit-credited',
      confirmations: BigInt(DEPTH),
    });
  });

  it('S6: same heights, different hashes — rewind, replay, never mix forks', async () => {
    const baseline = await reader.getTipHeight();
    let state: WatcherState = createWatcher({ confirmationDepth: DEPTH });
    const sync = async (): Promise<readonly WatcherEvent[]> => {
      const r = await syncToTip(reader, state, baseline, [CUSTODY]);
      state = r.state;
      return r.events;
    };

    const reorg = await beginReorg(anvil);
    await mine(1);
    await sendEth(anvil.rpcUrl, { to: CUSTODY, valueWei: AMOUNT });
    await mine(1); // original deposit at baseline+2
    await mine(1); // original tip baseline+3
    await sync();
    const originalHeader = state.headers.get(baseline + 2n);
    expect(depositsInState(state, 'seen')[0]?.amount).toBe(AMOUNT);

    const REPLACEMENT_AMOUNT = 111_111_111_111_111_111_111n;
    await reorg.revertAndReplace(async () => {
      await mine(1);
      await sendEth(anvil.rpcUrl, {
        to: CUSTODY,
        valueWei: REPLACEMENT_AMOUNT,
      });
      await mine(1); // replacement deposit, same height baseline+2
      await mine(2); // longer: tip baseline+4
    });

    const events = await sync();
    expect(events.map((e) => e.type)).toEqual([
      'deposit-removed',
      'deposit-seen',
    ]);

    // Exactly one deposit survives: the replacement branch's, at the
    // same height but under a different block hash.
    const survivors = depositsInState(state, 'seen');
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.amount).toBe(REPLACEMENT_AMOUNT);
    expect(survivors[0]?.inclusionHeight).toBe(baseline + 2n);
    expect(survivors[0]?.inclusionHash).not.toBe(originalHeader?.hash);

    // Every stored header matches the canonical chain — no fork mixing.
    for (let h = baseline + 1n; h <= (state.tip?.height ?? 0n); h++) {
      const chainHeader = await reader.getHeader(h);
      expect(state.headers.get(h)?.hash, `height ${h}`).toBe(chainHeader.hash);
    }
  });

  it('S7: a reorg deeper than N invalidating a credited deposit raises an alarm', async () => {
    const baseline = await reader.getTipHeight();
    let state: WatcherState = createWatcher({ confirmationDepth: DEPTH });
    const sync = async (): Promise<readonly WatcherEvent[]> => {
      const r = await syncToTip(reader, state, baseline, [CUSTODY]);
      state = r.state;
      return r.events;
    };

    const reorg = await beginReorg(anvil);
    await sendEth(anvil.rpcUrl, { to: CUSTODY, valueWei: AMOUNT });
    await mine(1); // inclusion baseline+1
    await mine(DEPTH - 1); // exactly N confirmations
    const before = await sync();
    expect(before.map((e) => e.type)).toEqual([
      'deposit-seen',
      'deposit-credited',
    ]);
    expect(creditedBalance(state, CUSTODY)).toBe(AMOUNT);

    // Replacement erases the credited deposit's whole branch.
    await reorg.revertAndReplace(async () => {
      await mine(DEPTH + 4);
    });

    const after = await sync();
    expect(after.map((e) => e.type)).toEqual(['deposit-removed', 'alarm']);
    expect(after[1]).toMatchObject({
      type: 'alarm',
      kind: 'credited-deposit-invalidated',
    });
    expect(creditedBalance(state, CUSTODY)).toBe(0n);
    expect(state.deposits.size).toBe(0);
  });
});
