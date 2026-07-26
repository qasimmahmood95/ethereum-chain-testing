// The only module that talks to a node (CLAUDE.md rule 3). Converts
// viem's view of the chain into the core's branded observation types.

import { createPublicClient, http, type PublicClient } from 'viem';
import { foundry } from 'viem/chains';
import { decodeTransferLog } from '../erc20.js';
import type {
  Address,
  BlockHeader,
  BlockObservation,
  DepositObservation,
  Wei,
} from '../types.js';
import { address, blockHash, txHash, wei } from '../types.js';

const BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export interface ChainReader {
  getTipHeight(): Promise<bigint>;
  getHeader(height: bigint): Promise<BlockHeader>;
  getBalance(at: Address, height: bigint): Promise<Wei>;
  /** ERC-20 balanceOf at a specific height — chain truth for tokens. */
  getTokenBalance(token: Address, at: Address, height: bigint): Promise<Wei>;
  /**
   * Observe blocks [from, to] (inclusive), returning for each block its
   * header, any *successful* native ETH transfers with value > 0 to a
   * watched address (reverted txs carry value in the block body but
   * move nothing), and any ERC-20 Transfer logs from watched tokens to
   * a watched address (logs only exist for successful txs; zero-value
   * transfers credit nothing, S14). Contract-internal native transfers
   * are out of scope.
   */
  observeBlocks(
    from: bigint,
    to: bigint,
    watched: readonly Address[],
    watchedTokens?: readonly Address[],
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
      // Height-pinned, not hash-pinned (unlike observeBlocks' logs):
      // fine on quiescent test chains; EIP-1898 would pin by hash.
      return wei(await client.getBalance({ address: at, blockNumber: height }));
    },

    async getTokenBalance(token, at, height) {
      const balance = await client.readContract({
        address: token,
        abi: BALANCE_OF_ABI,
        functionName: 'balanceOf',
        args: [at],
        blockNumber: height,
      });
      return wei(balance);
    },

    async observeBlocks(from, to, watched, watchedTokens = []) {
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
            asset: 'native',
          });
        }
        if (watchedTokens.length > 0) {
          // Logs fetched by block *hash*, not height — reorg-exact.
          const logs = await client.getLogs({
            address: [...watchedTokens],
            blockHash: blockHash(block.hash),
          });
          for (const log of logs) {
            if (log.logIndex === null || log.transactionHash === null) {
              continue; // pending log — cannot happen for a mined block
            }
            const transfer = decodeTransferLog({
              address: log.address,
              topics: log.topics,
              data: log.data,
              transactionHash: log.transactionHash,
              logIndex: log.logIndex,
            });
            if (transfer === null) continue;
            if (!watchedSet.has(transfer.to)) continue;
            if (transfer.value === 0n) continue;
            deposits.push({
              txHash: transfer.txHash,
              to: transfer.to,
              amount: transfer.value,
              asset: transfer.token,
              logIndex: transfer.logIndex,
            });
          }
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
