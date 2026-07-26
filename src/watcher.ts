// Deposit watcher: a pure state machine. Chain observations in,
// state + events out. No I/O, no viem, no clocks (CLAUDE.md rule 3).

import type {
  Address,
  BlockHeader,
  BlockObservation,
  DepositId,
  DepositRecord,
  WatcherConfig,
  WatcherEvent,
  Wei,
} from './types.js';
import { nativeDepositId, wei } from './types.js';

export interface WatcherState {
  readonly config: WatcherConfig;
  /** Canonical headers by height. Hashes are tracked, not just heights —
   * M3's ancestry check depends on it. */
  readonly headers: ReadonlyMap<bigint, BlockHeader>;
  readonly tip: BlockHeader | null;
  readonly deposits: ReadonlyMap<DepositId, DepositRecord>;
}

export interface ApplyResult {
  readonly state: WatcherState;
  readonly events: readonly WatcherEvent[];
}

export function createWatcher(config: WatcherConfig): WatcherState {
  if (
    !Number.isInteger(config.confirmationDepth) ||
    config.confirmationDepth < 1
  ) {
    throw new Error(
      `confirmationDepth must be an integer >= 1, got ${config.confirmationDepth}`,
    );
  }
  return {
    config,
    headers: new Map(),
    tip: null,
    deposits: new Map(),
  };
}

/**
 * Apply the next canonical block. Blocks must arrive in order, each
 * extending the current tip. A parent-hash mismatch is an ancestry
 * break; detection and rewind land in M3 — until then it is refused
 * loudly rather than absorbed silently.
 */
export function applyBlock(
  state: WatcherState,
  block: BlockObservation,
): ApplyResult {
  const { header } = block;

  if (state.tip !== null) {
    if (header.height !== state.tip.height + 1n) {
      throw new Error(
        `non-contiguous block: tip height ${state.tip.height}, got ${header.height}`,
      );
    }
    if (header.parentHash !== state.tip.hash) {
      throw new Error(
        `ancestry break at height ${header.height}: parent ${header.parentHash} ` +
          `does not match tip ${state.tip.hash} (reorg handling lands in M3)`,
      );
    }
  }

  const headers = new Map(state.headers);
  headers.set(header.height, header);

  const deposits = new Map(state.deposits);
  const events: WatcherEvent[] = [];

  for (const observation of block.deposits) {
    const id = nativeDepositId(observation.txHash);
    if (deposits.has(id)) {
      throw new Error(`duplicate deposit observation: ${id}`);
    }
    const record: DepositRecord = {
      id,
      txHash: observation.txHash,
      to: observation.to,
      amount: observation.amount,
      inclusionHeight: header.height,
      inclusionHash: header.hash,
      state: 'seen',
    };
    deposits.set(id, record);
    events.push({ type: 'deposit-seen', deposit: record });
  }

  // Credit pass: a deposit is credited when its inclusion block has N
  // confirmations on the canonical chain, i.e. tip - inclusion + 1 >= N.
  const depth = BigInt(state.config.confirmationDepth);
  for (const [id, record] of deposits) {
    if (record.state !== 'seen') continue;
    const confirmations = header.height - record.inclusionHeight + 1n;
    if (confirmations >= depth) {
      const credited: DepositRecord = { ...record, state: 'credited' };
      deposits.set(id, credited);
      events.push({
        type: 'deposit-credited',
        deposit: credited,
        confirmations,
      });
    }
  }

  return {
    state: { config: state.config, headers, tip: header, deposits },
    events,
  };
}

/** Sum of credited deposits for one address. Available funds only. */
export function creditedBalance(state: WatcherState, to: Address): Wei {
  let total = 0n;
  for (const record of state.deposits.values()) {
    if (record.state === 'credited' && record.to === to) {
      total += record.amount;
    }
  }
  return wei(total);
}

export function depositsInState(
  state: WatcherState,
  depositState: DepositRecord['state'],
): readonly DepositRecord[] {
  return [...state.deposits.values()].filter((d) => d.state === depositState);
}
