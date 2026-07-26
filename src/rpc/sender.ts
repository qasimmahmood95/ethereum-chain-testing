// The broadcast edge: signing and eth_sendRawTransaction live here,
// orchestrating the pure store in src/broadcaster.ts. The only other
// module that talks to a node is ./adapter.ts (CLAUDE.md rule 3).

import {
  createPublicClient,
  http,
  keccak256,
  type LocalAccount,
  type PublicClient,
} from 'viem';
import { sendRawTransaction } from 'viem/actions';
import { foundry } from 'viem/chains';
import {
  createBroadcastStore,
  decide,
  record,
  reserveNonce,
  type PreparedTx,
  type TransferIntent,
} from '../broadcaster.js';
import { txHash, type TxHash } from '../types.js';

const ANVIL_CHAIN_ID = 31337;

export interface SenderConfig {
  readonly rpcUrl: string;
  /** A local account (Anvil dev mnemonic in tests) that signs off-node,
   * so retries can rebroadcast identical bytes. */
  readonly account: LocalAccount;
  /** Explicit fee policy — deterministic tx bytes (CLAUDE.md rule 4). */
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  /** The account's on-chain nonce at start; the local allocator is the
   * source of truth from here on (ADR-0003). */
  readonly startNonce: bigint;
}

export interface Sender {
  /**
   * Submit an intent. Idempotent: any number of calls — concurrent or
   * sequential, before or after inclusion — moves funds at most once
   * and resolves to the same tx hash.
   */
  submit(intent: TransferIntent): Promise<TxHash>;
}

/** On the RETRY path only: rebroadcasting identical bytes is legal,
 * and these node answers mean "already have it / already mined". On a
 * first send every error is real — swallowing "nonce too low" there
 * would report success for a tx that can never mine. */
const BENIGN_REBROADCAST = [
  'already known',
  'already imported',
  'alreadyknown',
  'nonce too low',
];

export function createSender(config: SenderConfig): Sender {
  const client: PublicClient = createPublicClient({
    chain: foundry,
    transport: http(config.rpcUrl),
    cacheTime: 0,
  });

  let store = createBroadcastStore(config.startNonce);
  const inFlight = new Map<string, Promise<TxHash>>();
  let chainChecked = false;
  let poisoned: Error | undefined;

  async function broadcast(
    prepared: PreparedTx,
    isRebroadcast: boolean,
  ): Promise<TxHash> {
    try {
      await sendRawTransaction(client, {
        serializedTransaction: prepared.rawTx,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message.toLowerCase() : String(error);
      const benign =
        isRebroadcast &&
        BENIGN_REBROADCAST.some((answer) => message.includes(answer));
      if (!benign) throw error;
    }
    return prepared.txHash;
  }

  async function doSubmit(intent: TransferIntent): Promise<TxHash> {
    if (poisoned !== undefined) {
      // A reserve-without-record failure left a nonce gap; every later
      // tx would sit unmineable behind it. Refuse loudly rather than
      // silently freezing withdrawals (S10's custody risk).
      throw new Error(
        `sender poisoned by earlier failure: ${poisoned.message}`,
      );
    }
    if (!chainChecked) {
      const chainId = await client.getChainId();
      if (chainId !== ANVIL_CHAIN_ID) {
        throw new Error(
          `refusing to sign: expected chain id ${ANVIL_CHAIN_ID}, got ${chainId}`,
        );
      }
      chainChecked = true;
    }

    const decision = decide(store, intent);
    if (decision.action === 'rebroadcast') {
      // Retry path: identical bytes, same hash. Never re-signs, never
      // re-reads the pending nonce (ADR-0003).
      return broadcast(decision.prepared, true);
    }

    const reserved = reserveNonce(store);
    store = reserved.store;
    let prepared: PreparedTx;
    try {
      const rawTx = await config.account.signTransaction({
        chainId: ANVIL_CHAIN_ID,
        type: 'eip1559',
        nonce: Number(reserved.nonce),
        gas: 21_000n,
        maxFeePerGas: config.maxFeePerGas,
        maxPriorityFeePerGas: config.maxPriorityFeePerGas,
        to: intent.to,
        value: intent.amount,
      });
      prepared = {
        key: intent.key,
        to: intent.to,
        amount: intent.amount,
        nonce: reserved.nonce,
        rawTx,
        txHash: txHash(keccak256(rawTx)),
      };
      // Persist before the first broadcast: if we crash after this
      // line, a retry rebroadcasts these bytes — never double-spends.
      store = record(store, prepared);
    } catch (error) {
      poisoned = error instanceof Error ? error : new Error(String(error));
      throw error;
    }

    return broadcast(prepared, false);
  }

  return {
    submit(intent: TransferIntent): Promise<TxHash> {
      // Concurrent submits of one intent serialize here and share the
      // same resolution (S9).
      const existing = inFlight.get(intent.key);
      if (existing !== undefined) return existing;
      const pending = doSubmit(intent).finally(() => {
        inFlight.delete(intent.key);
      });
      inFlight.set(intent.key, pending);
      return pending;
    },
  };
}
