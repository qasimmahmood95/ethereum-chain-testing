// The only module that talks to a node (CLAUDE.md rule 3). Converts
// viem's view of the chain into the core's branded observation types.

import { createPublicClient, http, type PublicClient } from 'viem';
import { foundry } from 'viem/chains';
import type {
  Address,
  BlockHeader,
  BlockObservation,
  DepositObservation,
  Wei,
} from '../types.js';
import { address, blockHash, txHash, wei } from '../types.js';

export interface ChainReader {
  getTipHeight(): Promise<bigint>;
  getHeader(height: bigint): Promise<BlockHeader>;
  getBalance(at: Address, height: bigint): Promise<Wei>;
  /**
   * Observe blocks [from, to] (inclusive), returning for each block its
   * header and any *successful* native ETH transfers with value > 0 to
   * a watched address (reverted txs carry value in the block body but
   * move nothing). Contract-internal transfers are out of scope.
   */
  observeBlocks(
    from: bigint,
    to: bigint,
    watched: readonly Address[],
  ): Promise<BlockObservation[]>;
}

export function createChainReader(rpcUrl: string): ChainReader {
  const client: PublicClient = createPublicClient({
    chain: foundry,
    transport: http(rpcUrl),
    cacheTime: 0,
  });

  async function getHeader(height: bigint): Promise<BlockHeader> {
    const block = await client.getBlock({ blockNumber: height });
    return {
      height: block.number,
      hash: blockHash(block.hash),
      parentHash: blockHash(block.parentHash),
    };
  }

  return {
    getTipHeight: () => client.getBlockNumber(),

    getHeader,

    async getBalance(at, height) {
      return wei(await client.getBalance({ address: at, blockNumber: height }));
    },

    async observeBlocks(from, to, watched) {
      if (from > to) {
        throw new Error(`empty block range: ${from} > ${to}`);
      }
      const watchedSet = new Set<string>(watched);
      const observations: BlockObservation[] = [];
      for (let height = from; height <= to; height++) {
        const block = await client.getBlock({
          blockNumber: height,
          includeTransactions: true,
        });
        const deposits: DepositObservation[] = [];
        for (const tx of block.transactions) {
          if (tx.to === null || tx.value === 0n) continue;
          const to_ = address(tx.to);
          if (!watchedSet.has(to_)) continue;
          // A value-bearing tx to a watched *contract* can revert and
          // still sit in the block body with its value; crediting it
          // would book funds that never moved. Only successful txs
          // count as deposits.
          const receipt = await client.getTransactionReceipt({
            hash: tx.hash,
          });
          if (receipt.status !== 'success') continue;
          deposits.push({
            txHash: txHash(tx.hash),
            to: to_,
            amount: wei(tx.value),
          });
        }
        observations.push({
          header: {
            height: block.number,
            hash: blockHash(block.hash),
            parentHash: blockHash(block.parentHash),
          },
          deposits,
        });
      }
      return observations;
    },
  };
}
