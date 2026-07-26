// Reconciliation: the credited books versus chain truth at the
// confirmed height, per (address, asset). Pure — balances arrive as
// data (CLAUDE.md rule 3). Every discrepancy is reported with its
// exact delta; a deeper-than-N reorg against stale books surfaces
// here as exactly the invalidated amount (S7/S16).

import { creditedBalance, type WatcherState } from './watcher.js';
import type { Address, AssetId, Wei } from './types.js';

/** Chain truth for one (address, asset), read at the depth-N block. */
export interface BalanceObservation {
  readonly address: Address;
  readonly asset: AssetId;
  readonly chainBalance: Wei;
}

export interface ReconcileEntry {
  readonly address: Address;
  readonly asset: AssetId;
  readonly credited: Wei;
  readonly chainBalance: Wei;
  /** chainBalance − credited. Signed: negative means the books claim
   * funds the chain does not hold — the insolvency direction. */
  readonly delta: bigint;
}

export interface ReconcileReport {
  readonly entries: readonly ReconcileEntry[];
  readonly discrepancies: readonly ReconcileEntry[];
}

/**
 * Compare the watcher's credited set against observed chain balances.
 * Assumes the observations were taken at the confirmed height (tip −
 * N + 1): at that block, exactly the credited deposits have landed.
 */
export function reconcile(
  state: WatcherState,
  balances: readonly BalanceObservation[],
): ReconcileReport {
  const entries = balances.map((balance): ReconcileEntry => {
    const credited = creditedBalance(state, balance.address, balance.asset);
    return {
      address: balance.address,
      asset: balance.asset,
      credited,
      chainBalance: balance.chainBalance,
      delta: balance.chainBalance - credited,
    };
  });
  return {
    entries,
    discrepancies: entries.filter((entry) => entry.delta !== 0n),
  };
}
