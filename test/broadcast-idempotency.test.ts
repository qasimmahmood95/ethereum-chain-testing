// S8–S10 (docs/SCENARIOS.md): broadcast idempotency against Anvil with
// automine off. The invariant family: whatever the retry/race pattern,
// each intent moves funds exactly once, and nonces stay gapless.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TransactionReceiptNotFoundError } from 'viem';
import {
  startAnvil,
  useSnapshotReset,
  type AnvilInstance,
} from './harness/anvil.js';
import { devAccount } from './harness/accounts.js';
import { createSender, type Sender } from '../src/rpc/sender.js';
import { address, intentKey, wei, type TxHash } from '../src/types.js';
import type { TransferIntent } from '../src/broadcaster.js';

const SENDER_ACCOUNT = devAccount(0);

function recipient(i: number): `0x${string}` {
  return address(`0x${i.toString(16).padStart(2, '0').repeat(20)}`);
}

describe('S8–S10: broadcast idempotency against Anvil', () => {
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

  async function newSender(): Promise<Sender> {
    const startNonce = await anvil.publicClient.getTransactionCount({
      address: SENDER_ACCOUNT.address,
    });
    return createSender({
      rpcUrl: anvil.rpcUrl,
      account: SENDER_ACCOUNT,
      maxFeePerGas: 10_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      startNonce: BigInt(startNonce),
    });
  }

  function intent(
    key: string,
    to: `0x${string}`,
    amount: bigint,
  ): TransferIntent {
    return { key: intentKey(key), to: address(to), amount: wei(amount) };
  }

  async function senderTxCountOnChain(): Promise<number> {
    return anvil.publicClient.getTransactionCount({
      address: SENDER_ACCOUNT.address,
    });
  }

  it('S8: a retry after timeout rebroadcasts identical bytes — one transfer', async () => {
    const sender = await newSender();
    const to = recipient(0x61);
    const amount = 1_000_000_000_000_000_001n;
    const nonceBefore = await senderTxCountOnChain();

    const wd = intent('wd-s8', to, amount);
    const first = await sender.submit(wd);

    // No block mined: no receipt — the caller times out and retries.
    const receipt = await anvil.publicClient
      .getTransactionReceipt({ hash: first })
      .catch((error: unknown) => {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      });
    expect(receipt).toBeNull();

    const retried = await sender.submit(wd);
    expect(retried).toBe(first);

    await mine(1);

    // Exactly one transfer on chain, one nonce consumed.
    expect(await anvil.publicClient.getBalance({ address: to })).toBe(amount);
    expect(await senderTxCountOnChain()).toBe(nonceBefore + 1);
    const mined = await anvil.publicClient.getTransactionReceipt({
      hash: first,
    });
    expect(mined.status).toBe('success');
  });

  it('S9: two concurrent submits of one intent yield one nonce, one tx, same hash', async () => {
    const sender = await newSender();
    const to = recipient(0x62);
    const amount = 2_000_000_000_000_000_003n;
    const nonceBefore = await senderTxCountOnChain();

    const wd = intent('wd-s9', to, amount);
    const [a, b] = await Promise.all([sender.submit(wd), sender.submit(wd)]);
    expect(a).toBe(b);

    // And a late third submit, after the race resolved:
    expect(await sender.submit(wd)).toBe(a);

    await mine(1);
    expect(await anvil.publicClient.getBalance({ address: to })).toBe(amount);
    expect(await senderTxCountOnChain()).toBe(nonceBefore + 1);
  });

  it('S10: a burst of intents with interleaved retries stays gapless and confirms once each', async () => {
    const sender = await newSender();
    const nonceBefore = await senderTxCountOnChain();
    const COUNT = 8;

    const intents = Array.from({ length: COUNT }, (_, i) =>
      intent(`wd-s10-${i}`, recipient(0x70 + i), 10n ** 18n + BigInt(i) * 7n),
    );

    const hashes = new Map<string, TxHash>();
    // First wave: even intents.
    for (let i = 0; i < COUNT; i += 2) {
      const idx = intents[i];
      if (idx) hashes.set(idx.key, await sender.submit(idx));
    }
    // Interleaved: retry the evens while submitting the odds.
    const wave = await Promise.all(intents.map((it_) => sender.submit(it_)));
    wave.forEach((h, i) => {
      const it_ = intents[i];
      if (!it_) return;
      const prior = hashes.get(it_.key);
      if (prior !== undefined) expect(h).toBe(prior);
      hashes.set(it_.key, h);
    });
    // One more retry storm before anything mines.
    for (const it_ of intents) {
      expect(await sender.submit(it_)).toBe(hashes.get(it_.key));
    }

    await mine(1);

    // Every intent confirmed exactly once with the exact amount.
    for (const it_ of intents) {
      expect(await anvil.publicClient.getBalance({ address: it_.to })).toBe(
        it_.amount,
      );
    }
    // Nonces strictly monotonic and gapless.
    const nonces: number[] = [];
    for (const h of hashes.values()) {
      const tx = await anvil.publicClient.getTransaction({ hash: h });
      nonces.push(tx.nonce);
    }
    nonces.sort((x, y) => x - y);
    expect(nonces).toEqual(
      Array.from({ length: COUNT }, (_, i) => nonceBefore + i),
    );
    expect(await senderTxCountOnChain()).toBe(nonceBefore + COUNT);
  });
});
