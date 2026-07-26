// Deterministic reorgs via evm_snapshot / evm_revert (ADR-0002).
// Snapshot at the fork height, mine the original branch, revert, then
// mine a longer replacement branch. Replacement blocks get a diverging
// first timestamp (evm_setNextBlockTimestamp): without it Anvil can
// re-mine byte-identical blocks and the "reorg" is invisible to a
// hash-tracking watcher.

import type { Hex } from 'viem';
import type { AnvilInstance } from './anvil.js';

export interface ReorgHandle {
  /** Height of the common ancestor (the snapshot point). */
  readonly forkHeight: bigint;
  /**
   * Revert to the fork point and build the replacement branch by
   * running `build` (send txs, mine blocks — the caller scripts the
   * branch contents). The first replacement block's timestamp is
   * forced to diverge from the original branch so hashes differ even
   * for otherwise-identical blocks. Precondition: the original branch
   * mined at least one block after beginReorg (its first block's
   * timestamp is the divergence reference).
   */
  revertAndReplace(build: () => Promise<void>): Promise<void>;
}

export async function beginReorg(anvil: AnvilInstance): Promise<ReorgHandle> {
  const forkHeight = await anvil.publicClient.getBlockNumber();
  const snapshotId: Hex = await anvil.testClient.snapshot();

  return {
    forkHeight,

    async revertAndReplace(build: () => Promise<void>): Promise<void> {
      // The original branch's first block timestamp, captured before
      // the revert erases that branch.
      const original = await anvil.publicClient.getBlock({
        blockNumber: forkHeight + 1n,
      });

      // Anvil answers evm_revert with a boolean; viem's schema types it
      // void.
      const reverted = (await anvil.testClient.request({
        method: 'evm_revert',
        params: [snapshotId],
      })) as unknown as boolean;
      if (reverted !== true) {
        throw new Error(`evm_revert(${snapshotId}) returned false`);
      }

      // Diverge: any offset works as long as it differs from the
      // original and stays monotonic for the chain.
      await anvil.testClient.setNextBlockTimestamp({
        timestamp: original.timestamp + 977n,
      });

      await build();
    },
  };
}
