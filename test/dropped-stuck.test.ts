// S11–S12 (docs/SCENARIOS.md): mempool eviction and fee-bump
// replacement against Anvil, automine off. S11: an evicted tx is
// rebroadcast byte-identically and funds move exactly once. S12: a
// stuck-underpriced tx is replaced under the SAME nonce with bumped
// fees; exactly one of {original, replacement} confirms — never both,
// never neither.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startAnvil,
  useSnapshotReset,
  type AnvilInstance,
} from './harness/anvil.js';
import { devAccount } from './harness/accounts.js';
import { createSender, type Sender } from '../src/rpc/sender.js';
import { address, intentKey, wei } from '../src/types.js';
import type { TransferIntent } from '../src/broadcaster.js';

const SENDER_ACCOUNT = devAccount(0);
const GWEI = 1_000_000_000n;

describe('S11–S12: dropped and stuck transactions against Anvil', () => {
  let anvil: AnvilInstance;

  beforeAll(async () => {
    anvil = await startAnvil();
    await anvil.testClient.setAutomine(false);
  });

  afterAll(async () => {
    await anvil?.stop();
  });

  useSnapshotReset(() => anvil);

  const mine = (blocks: number) => anvil.testClient.mine({ blocks });

  async function newSender(fees?: {
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  }): Promise<Sender> {
    const startNonce = await anvil.publicClient.getTransactionCount({
      address: SENDER_ACCOUNT.address,
    });
    return createSender({
      rpcUrl: anvil.rpcUrl,
      account: SENDER_ACCOUNT,
      maxFeePerGas: fees?.maxFeePerGas ?? 10n * GWEI,
      maxPriorityFeePerGas: fees?.maxPriorityFeePerGas ?? 1n * GWEI,
      startNonce: BigInt(startNonce),
    });
  }

  it('S11: eviction detected, rebroadcast is byte-identical, funds move once', async () => {
    const sender = await newSender();
    const to = address(`0x${'51'.repeat(20)}`);
    const amount = 3_000_000_000_000_000_007n;
    const nonceBefore = await anvil.publicClient.getTransactionCount({
      address: SENDER_ACCOUNT.address,
    });

    const wd: TransferIntent = {
      key: intentKey('wd-s11'),
      to,
      amount: wei(amount),
    };
    const original = await sender.submit(wd);

    // The node evicts the tx from its pool.
    await anvil.testClient.dropTransaction({ hash: original });

    // Deadline passes (a block mines without our tx): non-inclusion
    // is detected, not assumed.
    await mine(1);
    const status = await sender.statusOf(wd.key);
    expect(status.state).toBe('pending');

    // Rebroadcast: identical bytes, same hash — never a re-sign.
    const rebroadcast = await sender.submit(wd);
    expect(rebroadcast).toBe(original);

    await mine(1);
    const after = await sender.statusOf(wd.key);
    expect(after).toMatchObject({
      state: 'included',
      attempt: { txHash: original },
    });
    expect(await anvil.publicClient.getBalance({ address: to })).toBe(amount);
    expect(
      await anvil.publicClient.getTransactionCount({
        address: SENDER_ACCOUNT.address,
      }),
    ).toBe(nonceBefore + 1);
  });

  it('S12: stuck underpriced, bumped under the same nonce — exactly one confirms', async () => {
    // Original fee policy too low for the coming base-fee spike.
    const sender = await newSender({
      maxFeePerGas: 2n * GWEI,
      maxPriorityFeePerGas: 1n * GWEI,
    });
    const to = address(`0x${'52'.repeat(20)}`);
    const amount = 4_000_000_000_000_000_009n;
    const nonceBefore = await anvil.publicClient.getTransactionCount({
      address: SENDER_ACCOUNT.address,
    });

    const wd: TransferIntent = {
      key: intentKey('wd-s12'),
      to,
      amount: wei(amount),
    };
    const original = await sender.submit(wd);

    // Base fee spikes above the original's cap: the tx is stuck.
    await anvil.testClient.setNextBlockBaseFeePerGas({
      baseFeePerGas: 20n * GWEI,
    });
    await mine(1);
    expect((await sender.statusOf(wd.key)).state).toBe('pending');

    // Deliberate replacement: same nonce, properly bumped fees.
    const replacement = await sender.bump(wd.key, {
      maxFeePerGas: 30n * GWEI,
      maxPriorityFeePerGas: 2n * GWEI,
    });
    expect(replacement).not.toBe(original);

    // The replacement clears immediately; then keep mining until the
    // decayed base fee would have admitted the original, proving it
    // can never also confirm (its nonce is spent).
    await mine(1);
    const included = await sender.statusOf(wd.key);
    expect(included).toMatchObject({
      state: 'included',
      attempt: { txHash: replacement },
    });
    await mine(20); // base fee decays far below the original's 2 gwei cap

    // Exactly one of {original, replacement} on chain — never both,
    // never neither.
    const replacementReceipt = await anvil.publicClient.getTransactionReceipt({
      hash: replacement,
    });
    expect(replacementReceipt.status).toBe('success');
    const originalReceipt = await anvil.publicClient
      .getTransactionReceipt({ hash: original })
      .catch(() => null);
    expect(originalReceipt).toBeNull();

    // The intent completed exactly once: one transfer, one nonce.
    expect(await anvil.publicClient.getBalance({ address: to })).toBe(amount);
    expect(
      await anvil.publicClient.getTransactionCount({
        address: SENDER_ACCOUNT.address,
      }),
    ).toBe(nonceBefore + 1);
  });
});
