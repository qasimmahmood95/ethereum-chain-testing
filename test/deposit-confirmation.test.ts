// S1–S3 (docs/SCENARIOS.md): native ETH deposit lifecycle against a
// real Anvil node. N is small and explicit — nothing here or in the
// library knows a default depth.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startAnvil,
  useSnapshotReset,
  type AnvilInstance,
} from './harness/anvil.js';
import { sendEth } from './harness/accounts.js';
import { createChainReader, type ChainReader } from '../src/rpc/adapter.js';
import {
  applyBlock,
  createWatcher,
  creditedBalance,
  depositsInState,
  type WatcherState,
} from '../src/watcher.js';
import { address, wei, type WatcherEvent } from '../src/types.js';

const DEPTH = 5;
const CUSTODY = address(`0x${'11'.repeat(20)}`);
// Odd, > 2^53 wei: proves amounts survive as exact bigints end to end.
const AMOUNT = 123_456_789_012_345_678_901n;

describe('S1–S3: deposit confirmation depth against Anvil', () => {
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

  /**
   * Feed every not-yet-applied block up to the current tip into the
   * watcher: from the block after the watcher's tip, or from
   * `firstHeight` on the first call.
   */
  async function catchUp(
    state: WatcherState,
    firstHeight: bigint,
  ): Promise<{ state: WatcherState; events: WatcherEvent[] }> {
    const from = state.tip === null ? firstHeight : state.tip.height + 1n;
    const tip = await reader.getTipHeight();
    const events: WatcherEvent[] = [];
    if (from > tip) return { state, events };
    for (const observation of await reader.observeBlocks(from, tip, [
      CUSTODY,
    ])) {
      const result = applyBlock(state, observation);
      state = result.state;
      events.push(...result.events);
    }
    return { state, events };
  }

  async function mine(blocks: number): Promise<void> {
    await anvil.testClient.mine({ blocks });
  }

  it('S1: seen at 1 confirmation with the exact wei amount, not credited', async () => {
    const baseline = await reader.getTipHeight();
    let state = createWatcher({ confirmationDepth: DEPTH });

    await sendEth(anvil.rpcUrl, { to: CUSTODY, valueWei: AMOUNT });
    await mine(1);

    const caught = await catchUp(state, baseline + 1n);
    state = caught.state;

    expect(caught.events.map((e) => e.type)).toEqual(['deposit-seen']);
    const [seen] = depositsInState(state, 'seen');
    expect(seen?.amount).toBe(AMOUNT);
    expect(seen?.to).toBe(CUSTODY);
    expect(seen?.inclusionHeight).toBe(baseline + 1n);
    expect(depositsInState(state, 'credited')).toHaveLength(0);
    expect(creditedBalance(state, CUSTODY)).toBe(0n);
  });

  it('S3: at exactly N-1 confirmations the deposit is still only seen', async () => {
    const baseline = await reader.getTipHeight();
    let state = createWatcher({ confirmationDepth: DEPTH });

    await sendEth(anvil.rpcUrl, { to: CUSTODY, valueWei: AMOUNT });
    await mine(1); // inclusion: 1 confirmation
    await mine(DEPTH - 2); // total confirmations: N-1

    const caught = await catchUp(state, baseline + 1n);
    state = caught.state;

    expect(caught.events.map((e) => e.type)).toEqual(['deposit-seen']);
    expect(depositsInState(state, 'seen')).toHaveLength(1);
    expect(depositsInState(state, 'credited')).toHaveLength(0);
    expect(creditedBalance(state, CUSTODY)).toBe(0n);

    // One more block crosses the boundary.
    await mine(1);
    const crossed = await catchUp(state, baseline + 1n);
    expect(crossed.events.map((e) => e.type)).toEqual(['deposit-credited']);
  });

  it('S2: credits exactly once, at exactly depth N, with the on-chain wei value', async () => {
    const baseline = await reader.getTipHeight();
    let state = createWatcher({ confirmationDepth: DEPTH });

    await sendEth(anvil.rpcUrl, { to: CUSTODY, valueWei: AMOUNT });
    await mine(1);
    const inclusion = baseline + 1n;

    // Walk the head forward one block at a time and record at which
    // confirmation count the credit fires.
    const creditedAt: bigint[] = [];
    let caught = await catchUp(state, inclusion);
    state = caught.state;
    for (let extra = 0; extra < DEPTH + 2; extra++) {
      await mine(1);
      caught = await catchUp(state, inclusion);
      state = caught.state;
      for (const event of caught.events) {
        if (event.type === 'deposit-credited') {
          creditedAt.push(event.confirmations);
          expect(event.deposit.amount).toBe(AMOUNT);
        }
      }
    }

    // Exactly one credit, at exactly N confirmations — never a second.
    expect(creditedAt).toEqual([BigInt(DEPTH)]);
    expect(creditedBalance(state, CUSTODY)).toBe(AMOUNT);

    // Chain truth agrees at the crediting height (inclusion + N - 1).
    const chainBalance = await reader.getBalance(
      CUSTODY,
      inclusion + BigInt(DEPTH) - 1n,
    );
    expect(chainBalance).toBe(wei(AMOUNT));
  });
});
