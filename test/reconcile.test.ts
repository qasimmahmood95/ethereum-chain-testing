// S16 (docs/SCENARIOS.md): after a scripted mix of deposits, a reorg,
// a broadcast retry and a fee bump, the credited books equal chain
// truth at the confirmed height — and a deeper-than-N reorg against
// stale books surfaces as an exact discrepancy (the S7 tie-in).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startAnvil,
  useSnapshotReset,
  type AnvilInstance,
} from './harness/anvil.js';
import { DEV_ACCOUNT_0, devAccount, sendEth } from './harness/accounts.js';
import {
  deployToken,
  mintToken,
  transferToken,
  type TokenHandle,
} from './harness/token.js';
import { beginReorg } from './harness/reorg.js';
import { syncToTip } from './harness/sync.js';
import { createChainReader, type ChainReader } from '../src/rpc/adapter.js';
import { createSender } from '../src/rpc/sender.js';
import { reconcile, type BalanceObservation } from '../src/reconcile.js';
import { createWatcher, type WatcherState } from '../src/watcher.js';
import { address, intentKey, wei } from '../src/types.js';

const DEPTH = 4;
const CUSTODY = address(`0x${'88'.repeat(20)}`);
const NATIVE_1 = 1_234_567_890_123_456_789n;
const NATIVE_2 = 555_555_555_555_555_557n;
const TOKEN_1 = 9_007_199_254_740_997n;

describe('S16: reconciliation against Anvil', () => {
  let anvil: AnvilInstance;
  let reader: ChainReader;
  let token: TokenHandle;

  beforeAll(async () => {
    anvil = await startAnvil();
    await anvil.testClient.setAutomine(false);
    reader = createChainReader(anvil.rpcUrl);
    token = await deployToken(anvil, { decimals: 6 });
    await mintToken(anvil, token, DEV_ACCOUNT_0, 10n ** 24n);
    await anvil.testClient.mine({ blocks: 1 });
  });

  afterAll(async () => {
    await anvil?.stop();
  });

  useSnapshotReset(() => anvil);

  const mine = (blocks: number) => anvil.testClient.mine({ blocks });

  async function balancesAt(height: bigint): Promise<BalanceObservation[]> {
    return [
      {
        address: CUSTODY,
        asset: 'native',
        chainBalance: await reader.getBalance(CUSTODY, height),
      },
      {
        address: CUSTODY,
        asset: address(token.address),
        chainBalance: await reader.getTokenBalance(
          address(token.address),
          CUSTODY,
          height,
        ),
      },
    ];
  }

  it('S16: zero discrepancies after deposits, a reorg, a retry and a bump — then a deep reorg shows its exact delta', async () => {
    const baseline = await reader.getTipHeight();
    // Captured before any deposit: the S7 finale reorgs all of it away.
    const deepReorg = await beginReorg(anvil);
    let state: WatcherState = createWatcher({ confirmationDepth: DEPTH });
    const sync = async () => {
      const r = await syncToTip(
        reader,
        state,
        baseline,
        [CUSTODY],
        [address(token.address)],
      );
      state = r.state;
      return r.events;
    };

    // -- The scripted mix ------------------------------------------------
    // 1. Native + token deposits that will survive and credit.
    await sendEth(anvil.rpcUrl, { to: CUSTODY, valueWei: NATIVE_1 });
    await transferToken(anvil, token, CUSTODY, TOKEN_1);
    await mine(1);

    // 2. A deposit that gets reorged out below depth (never credits).
    const reorg = await beginReorg(anvil);
    await sendEth(anvil.rpcUrl, { to: CUSTODY, valueWei: 777_777_777n });
    await mine(1);
    await sync(); // observe it as seen pre-reorg
    await reorg.revertAndReplace(async () => {
      await mine(2); // longer branch without it
    });

    // 3. Broadcast machinery interleaved: a retry (S8-style) and a fee
    //    bump (S12-style) from a non-custody account — the books must
    //    stay untouched by outbound traffic.
    const senderAccount = devAccount(3);
    const sender = createSender({
      rpcUrl: anvil.rpcUrl,
      account: senderAccount,
      maxFeePerGas: 10_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      startNonce: BigInt(
        await anvil.publicClient.getTransactionCount({
          address: senderAccount.address,
        }),
      ),
    });
    const wd = {
      key: intentKey('wd-s16'),
      to: address(`0x${'99'.repeat(20)}`),
      amount: wei(1_000_000_000_000_000n),
    };
    await sender.submit(wd);
    await sender.submit(wd); // retry before inclusion
    await sender.bump(wd.key, {
      maxFeePerGas: 20_000_000_000n,
      maxPriorityFeePerGas: 2_000_000_000n,
    });

    // 4. A second surviving native deposit, then confirm everything.
    await sendEth(anvil.rpcUrl, { to: CUSTODY, valueWei: NATIVE_2 });
    await mine(1);
    await mine(DEPTH); // everything above reaches depth N
    await sync();

    // -- Happy path: books equal chain truth at the confirmed height ----
    const tip = await reader.getTipHeight();
    const confirmedHeight = tip - BigInt(DEPTH) + 1n;
    const report = reconcile(state, await balancesAt(confirmedHeight));
    expect(report.discrepancies).toEqual([]);
    expect(report.entries.map((e) => e.credited)).toEqual([
      NATIVE_1 + NATIVE_2,
      TOKEN_1,
    ]);

    // -- S7 tie-in: a reorg deeper than N erases the credited branch ----
    const staleBooks = state;
    await deepReorg.revertAndReplace(async () => {
      await mine(12); // strictly longer than the erased history
    });

    // Stale books vs the new chain: the exact invalidated amounts,
    // never silent.
    const newTip = await reader.getTipHeight();
    const divergence = reconcile(staleBooks, await balancesAt(newTip));
    expect(divergence.discrepancies).toHaveLength(2);
    expect(divergence.discrepancies.map((d) => d.delta)).toEqual([
      -(NATIVE_1 + NATIVE_2),
      -TOKEN_1,
    ]);

    // Processing the reorg (removals + alarms) restores clean books.
    const events = await sync();
    expect(
      events.filter((e) => e.type === 'alarm').length,
    ).toBeGreaterThanOrEqual(1);
    const healed = reconcile(state, await balancesAt(newTip));
    expect(healed.discrepancies).toEqual([]);
  });
});
