import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ANVIL_CHAIN_ID,
  startAnvil,
  useSnapshotReset,
  type AnvilInstance,
} from './harness/anvil.js';

describe('anvil harness', () => {
  let anvil: AnvilInstance;

  beforeAll(async () => {
    anvil = await startAnvil();
    // Surfaced in CI logs: proves a real node ran, and which build.
    console.log(`[harness] ${anvil.version} listening on ${anvil.rpcUrl}`);
  });

  afterAll(async () => {
    await anvil.stop();
  });

  it('serves the Anvil dev chain id', async () => {
    await expect(anvil.publicClient.getChainId()).resolves.toBe(ANVIL_CHAIN_ID);
  });

  it('mines a block and reads it back, linked to its parent', async () => {
    const before = await anvil.publicClient.getBlockNumber();
    await anvil.testClient.mine({ blocks: 1 });

    const parent = await anvil.publicClient.getBlock({ blockNumber: before });
    const mined = await anvil.publicClient.getBlock({
      blockNumber: before + 1n,
    });
    expect(mined.number).toBe(before + 1n);
    expect(mined.parentHash).toBe(parent.hash);
  });

  describe('opt-in snapshot/revert reset', () => {
    useSnapshotReset(() => anvil);

    let baseline: bigint;

    beforeAll(async () => {
      baseline = await anvil.publicClient.getBlockNumber();
    });

    it('lets a test mutate chain state freely', async () => {
      await anvil.testClient.mine({ blocks: 3 });
      await expect(anvil.publicClient.getBlockNumber()).resolves.toBe(
        baseline + 3n,
      );
    });

    it('resets that state before the next test', async () => {
      await expect(anvil.publicClient.getBlockNumber()).resolves.toBe(baseline);
    });
  });
});
