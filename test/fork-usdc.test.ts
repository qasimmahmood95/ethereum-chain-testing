// Optional pinned-fork lane (ADR-0004): the watcher scenarios against
// real mainnet USDC on an Anvil fork at a pinned block. Runs ONLY when
// FORK_RPC_URL is set — CI never depends on a live RPC; without the
// secret this whole suite skips. The fork's chain id is forced to
// 31337, keeping hard rule 1 intact (and making every signature
// invalid on real mainnet by construction).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWalletClient, http } from 'viem';
import { foundry } from 'viem/chains';
import { startAnvil, type AnvilInstance } from './harness/anvil.js';
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

const FORK_RPC_URL = process.env['FORK_RPC_URL'];
/** Mainnet, 2024-11-06 — pinned so the fork state is cacheable. */
const FORK_BLOCK = 21_000_000n;
const USDC = address('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
/** Circle's hot wallet: reliably holds enormous USDC at the pin. */
const WHALE = address('0x55fe002aeff02f77364de339a1292923a15844b8');
const CUSTODY = address(`0x${'aa'.repeat(20)}`);
const AMOUNT = 12_345_678_901n; // 12,345.678901 USDC in minor units
const DEPTH = 4;
const SLOW = { timeout: 120_000 };

const ERC20_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

describe.skipIf(!FORK_RPC_URL)('pinned-fork lane: real USDC', () => {
  let anvil: AnvilInstance;
  let reader: ChainReader;

  beforeAll(async () => {
    anvil = await startAnvil({
      args: [
        '--fork-url',
        FORK_RPC_URL ?? '',
        '--fork-block-number',
        FORK_BLOCK.toString(),
        '--chain-id',
        '31337',
      ],
    });
    await anvil.testClient.setAutomine(false);
    reader = createChainReader(anvil.rpcUrl);

    // The whale must cover the transfer at the pinned block; a clear
    // failure here means "pick a different whale", not a bug.
    const whaleBalance = await reader.getTokenBalance(USDC, WHALE, FORK_BLOCK);
    expect(whaleBalance).toBeGreaterThanOrEqual(AMOUNT * 2n);

    await anvil.testClient.impersonateAccount({ address: WHALE });
    await anvil.testClient.setBalance({
      address: WHALE,
      value: 10n ** 18n, // gas money on the fork only
    });
  }, 120_000);

  afterAll(async () => {
    await anvil?.stop();
  });

  async function sendUsdc(amount: bigint): Promise<void> {
    const wallet = createWalletClient({
      chain: foundry,
      transport: http(anvil.rpcUrl),
    });
    await wallet.writeContract({
      address: USDC,
      abi: ERC20_TRANSFER_ABI,
      functionName: 'transfer',
      args: [CUSTODY, amount],
      account: WHALE,
      chain: foundry,
    });
  }

  const mine = (blocks: number) => anvil.testClient.mine({ blocks });

  function makeSync(baseline: bigint) {
    let state: WatcherState = createWatcher({ confirmationDepth: DEPTH });
    return {
      get state() {
        return state;
      },
      async sync(): Promise<readonly WatcherEvent[]> {
        const r = await syncToTip(reader, state, baseline + 1n, [CUSTODY], [
          USDC,
        ]);
        state = r.state;
        return r.events;
      },
    };
  }

  it('S13-on-fork: a real USDC deposit credits at exactly depth N', SLOW, async () => {
    const baseline = await reader.getTipHeight();
    const w = makeSync(baseline);

    await sendUsdc(AMOUNT);
    await mine(1);
    const seen = await w.sync();
    expect(seen.map((e) => e.type)).toEqual(['deposit-seen']);
    expect(depositsInState(w.state, 'seen')[0]?.amount).toBe(AMOUNT);
    expect(depositsInState(w.state, 'seen')[0]?.asset).toBe(USDC);

    await mine(DEPTH - 2); // N-1 confirmations
    expect(await w.sync()).toEqual([]);
    expect(creditedBalance(w.state, CUSTODY, USDC)).toBe(0n);

    await mine(1); // exactly N
    const credited = await w.sync();
    expect(credited).toEqual([
      expect.objectContaining({
        type: 'deposit-credited',
        confirmations: BigInt(DEPTH),
      }),
    ]);
    expect(creditedBalance(w.state, CUSTODY, USDC)).toBe(AMOUNT);

    const creditingHeight = baseline + BigInt(DEPTH);
    expect(await reader.getTokenBalance(USDC, CUSTODY, creditingHeight)).toBe(
      AMOUNT,
    );
  });

  it('S15-on-fork: a reorged-out USDC deposit un-credits', SLOW, async () => {
    const baseline = await reader.getTipHeight();
    const w = makeSync(baseline);

    const reorg = await beginReorg(anvil);
    await sendUsdc(AMOUNT);
    await mine(2); // seen, below depth
    expect((await w.sync()).map((e) => e.type)).toEqual(['deposit-seen']);

    await reorg.revertAndReplace(async () => {
      await mine(4); // longer branch without the transfer
    });

    const events = await w.sync();
    expect(events.map((e) => e.type)).toEqual(['deposit-removed']);
    expect(creditedBalance(w.state, CUSTODY, USDC)).toBe(0n);
    const tip = await reader.getTipHeight();
    expect(await reader.getTokenBalance(USDC, CUSTODY, tip)).toBe(0n);
  });
});
