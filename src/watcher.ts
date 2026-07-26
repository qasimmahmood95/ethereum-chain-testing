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
   * the ancestry check depends on it. Retained unbounded: the rewind
   * horizon is the full observed history, so a reorg to any observed
   * ancestor can be replayed (and one deeper than history is refused
   * loudly in reorgTo). */
  readonly headers: ReadonlyMap<bigint, BlockHeader>;
  readonly tip: BlockHeader | null;
  readonly deposits: ReadonlyMap<DepositId, DepositRecord>;
}

export interface ApplyResult {
  readonly state: WatcherState;
  readonly events: readonly WatcherEvent[];
  /**
   * 'applied': the block extended the canonical chain.
   * 'ancestry-break': the block's parent hash does not match the tip —
   * the canonical chain no longer contains our tip. State is unchanged;
   * the caller must fetch the replacement chain back to a common
   * ancestor and call reorgTo (S6).
   */
  readonly outcome: 'applied' | 'ancestry-break';
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
 * Apply the next canonical block. Blocks must arrive in height order,
 * each claiming to extend the current tip; a parent-hash mismatch is
 * reported as an ancestry break (never absorbed silently), leaving
 * state untouched.
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
      return { state, events: [], outcome: 'ancestry-break' };
    }
  }

  const headers = new Map(state.headers);
  const deposits = new Map(state.deposits);
  const events: WatcherEvent[] = [];
  applyToMaps(state.config, headers, deposits, events, block);

  return {
    state: { config: state.config, headers, tip: header, deposits },
    events,
    outcome: 'applied',
  };
}

/**
 * Adopt a strictly longer replacement chain after an ancestry break.
 * `replacement` must be contiguous, start directly above a known
 * canonical header (the common ancestor, identified by parent hash),
 * and end above the current tip. Deposits whose inclusion block left
 * the canonical chain are removed — with an explicit alarm if they
 * were already credited (S7) — then the replacement blocks are
 * replayed, so credit only ever counts confirmations on the current
 * canonical chain (S5).
 */
export function reorgTo(
  state: WatcherState,
  replacement: readonly BlockObservation[],
): ApplyResult {
  if (state.tip === null) {
    throw new Error('reorgTo before any block was applied');
  }
  const first = replacement[0];
  if (first === undefined) {
    throw new Error('reorgTo requires a non-empty replacement chain');
  }

  const ancestorHeight = first.header.height - 1n;
  const ancestor = state.headers.get(ancestorHeight);
  if (ancestor === undefined) {
    throw new Error(
      `reorg deeper than observed history: no header at height ${ancestorHeight}`,
    );
  }
  if (first.header.parentHash !== ancestor.hash) {
    throw new Error(
      `replacement does not attach: parent ${first.header.parentHash} != ` +
        `ancestor ${ancestor.hash} at height ${ancestorHeight}`,
    );
  }
  // An ancestor chosen too deep would replay known-canonical blocks as
  // fresh sightings, emitting spurious removals and alarms — refuse.
  if (state.headers.get(first.header.height)?.hash === first.header.hash) {
    throw new Error(
      `replacement does not diverge at height ${first.header.height} — ` +
        `ancestor chosen too deep`,
    );
  }
  for (let i = 1; i < replacement.length; i++) {
    const prev = replacement[i - 1];
    const next = replacement[i];
    if (prev === undefined || next === undefined) break;
    if (
      next.header.height !== prev.header.height + 1n ||
      next.header.parentHash !== prev.header.hash
    ) {
      throw new Error(
        `replacement chain not contiguous at height ${next.header.height}`,
      );
    }
  }
  const last = replacement[replacement.length - 1];
  if (last === undefined || last.header.height <= state.tip.height) {
    throw new Error(
      `replacement must be strictly longer: ends at ${String(
        last?.header.height,
      )}, tip is ${state.tip.height}`,
    );
  }

  // Rewind: drop headers above the ancestor and remove every deposit
  // whose inclusion block just left the canonical chain.
  const headers = new Map<bigint, BlockHeader>();
  for (const [height, header] of state.headers) {
    if (height <= ancestorHeight) headers.set(height, header);
  }
  const deposits = new Map(state.deposits);
  const events: WatcherEvent[] = [];
  for (const [id, record] of state.deposits) {
    if (record.inclusionHeight > ancestorHeight) {
      deposits.delete(id);
      events.push({
        type: 'deposit-removed',
        deposit: record,
        reason: 'reorged-out',
      });
      if (record.state === 'credited') {
        events.push({
          type: 'alarm',
          kind: 'credited-deposit-invalidated',
          deposit: record,
        });
      }
    }
  }

  // Replay the replacement chain; re-included txs are fresh sightings.
  for (const block of replacement) {
    applyToMaps(state.config, headers, deposits, events, block);
  }

  const tip = last.header;
  return {
    state: { config: state.config, headers, tip, deposits },
    events,
    outcome: 'applied',
  };
}

/** Shared per-block ingestion: record deposits, then run the credit pass. */
function applyToMaps(
  config: WatcherConfig,
  headers: Map<bigint, BlockHeader>,
  deposits: Map<DepositId, DepositRecord>,
  events: WatcherEvent[],
  block: BlockObservation,
): void {
  const { header } = block;
  headers.set(header.height, header);

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
  const depth = BigInt(config.confirmationDepth);
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
