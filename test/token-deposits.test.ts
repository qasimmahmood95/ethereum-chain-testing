// S13–S15 (docs/SCENARIOS.md): ERC-20 deposits through the same
// watcher state machine as native ETH — same confirmation depth, same
// reorg handling (S15 reuses the M3 harness). Tokens at 6 and 18
// decimals, amounts past 2^53 minor units.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startAnvil,
  useSnapshotReset,
  type AnvilInstance,
} from './harness/anvil.js';
import {
  batchTransferToken,
  deployToken,
  mintToken,
  transferToken,
  type TokenHandle,
} from './harness/token.js';
import { DEV_ACCOUNT_0 } from './harness/accounts.js';
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

const DEPTH = 4;
const CUSTODY = address(`0x${'66'.repeat(20)}`);
// Odd and > 2^53: exactness must survive the whole pipeline.
const AMOUNT = 9_007_199_254_740_993n; // 2^53 + 1
const SUPPLY = 10n ** 30n;

describe('S13–S15: token deposits against Anvil', () => {
  let anvil: AnvilInstance;
  let reader: ChainReader;
  let token6: TokenHandle;
  let token18: TokenHandle;

  beforeAll(async () => {
    anvil = await startAnvil();
    await anvil.testClient.setAutomine(false);
    reader = createChainReader(anvil.rpcUrl);
    token6 = await deployToken(anvil, { decimals: 6 });
    token18 = await deployToken(anvil, { decimals: 18 });
    for (const token of [token6, token18]) {
      await mintToken(anvil, token, DEV_ACCOUNT_0, SUPPLY);
    }
    await anvil.testClient.mine({ blocks: 1 });
  });

  afterAll(async () => {
    await anvil?.stop();
  });

  useSnapshotReset(() => anvil);

  const mine = (blocks: number) => anvil.testClient.mine({ blocks });

  function makeSync(baseline: bigint, tokens: readonly TokenHandle[]) {
    let state: WatcherState = createWatcher({ confirmationDepth: DEPTH });
    return {
      get state() {
        return state;
      },
      async sync(): Promise<readonly WatcherEvent[]> {
        const r = await syncToTip(
          reader,
          state,
          baseline,
          [CUSTODY],
          tokens.map((t) => address(t.address)),
        );
        state = r.state;
        return r.events;
      },
    };
  }

  it('S13: exact bigint minor units, credited at exactly N, for 6 and 18 decimals', async () => {
    for (const token of [token6, token18]) {
      const baseline = await reader.getTipHeight();
      const w = makeSync(baseline, [token]);
      const asset = address(token.address);

      await transferToken(anvil, token, CUSTODY, AMOUNT);
      await mine(1);
      const seen = await w.sync();
      expect(
        seen.map((e) => e.type),
        `decimals ${token.decimals}`,
      ).toEqual(['deposit-seen']);
      expect(depositsInState(w.state, 'seen')[0]?.amount).toBe(AMOUNT);
      expect(depositsInState(w.state, 'seen')[0]?.asset).toBe(asset);

      await mine(DEPTH - 2); // N-1 confirmations: still seen
      expect((await w.sync()).length).toBe(0);
      expect(creditedBalance(w.state, CUSTODY, asset)).toBe(0n);

      await mine(1); // exactly N
      const credited = await w.sync();
      expect(credited).toEqual([
        expect.objectContaining({
          type: 'deposit-credited',
          confirmations: BigInt(DEPTH),
        }),
      ]);
      expect(creditedBalance(w.state, CUSTODY, asset)).toBe(AMOUNT);

      // Chain truth at the crediting height agrees exactly.
      const creditingHeight = baseline + 1n + BigInt(DEPTH) - 1n;
      expect(
        await reader.getTokenBalance(asset, CUSTODY, creditingHeight),
      ).toBe(AMOUNT);
    }
  });

  it('S14: zero-value transfers credit nothing; multiple transfers in one tx/block each credit once', async () => {
    const baseline = await reader.getTipHeight();
    const w = makeSync(baseline, [token6]);
    const asset = address(token6.address);

    // Zero-value spam plus a batch of three custody transfers in ONE
    // tx, plus a separate plain transfer — all in the same block.
    const amounts = [AMOUNT, 7n, 1_000_001n] as const;
    await transferToken(anvil, token6, CUSTODY, 0n); // zero-value: no deposit
    await batchTransferToken(
      anvil,
      token6,
      [CUSTODY, address(`0x${'77'.repeat(20)}`), CUSTODY, CUSTODY],
      [amounts[0], 999n, amounts[1], amounts[2]],
    );
    const plain = 42n;
    await transferToken(anvil, token6, CUSTODY, plain);
    await mine(1);

    const seen = await w.sync();
    // Exactly four deposits: three batch legs to custody + the plain
    // transfer. The zero-value and third-party legs credit nothing.
    expect(seen.map((e) => e.type)).toEqual(Array(4).fill('deposit-seen'));
    const ids = depositsInState(w.state, 'seen').map((d) => d.id);
    expect(new Set(ids).size).toBe(4);

    await mine(DEPTH - 1);
    const credited = await w.sync();
    expect(credited.filter((e) => e.type === 'deposit-credited')).toHaveLength(
      4,
    );
    expect(creditedBalance(w.state, CUSTODY, asset)).toBe(
      amounts[0] + amounts[1] + amounts[2] + plain,
    );

    // Nothing double-credits later.
    await mine(2);
    expect(await w.sync()).toEqual([]);
  });

  it('S15: a token deposit reorged out before depth un-credits like native ETH', async () => {
    const baseline = await reader.getTipHeight();
    const w = makeSync(baseline, [token6]);
    const asset = address(token6.address);

    const reorg = await beginReorg(anvil);
    await transferToken(anvil, token6, CUSTODY, AMOUNT);
    await mine(2); // seen, below depth
    expect((await w.sync()).map((e) => e.type)).toEqual(['deposit-seen']);

    await reorg.revertAndReplace(async () => {
      await mine(4); // longer branch without the transfer
    });

    const events = await w.sync();
    expect(events.map((e) => e.type)).toEqual(['deposit-removed']);
    expect(w.state.deposits.size).toBe(0);
    expect(creditedBalance(w.state, CUSTODY, asset)).toBe(0n);

    // Chain truth: the token contract reverted with the chain.
    const tip = await reader.getTipHeight();
    expect(await reader.getTokenBalance(asset, CUSTODY, tip)).toBe(0n);
  });
});
