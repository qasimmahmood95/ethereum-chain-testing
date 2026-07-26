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
 *
 * Preconditions the caller owns:
 * - Observations were taken at the confirmed height (tip − N + 1): at
 *   that block, exactly the credited deposits have landed, and
 *   seen-but-uncredited ones (included above it) are excluded.
 * - Custody addresses are deposit-only with a zero balance at the
 *   watcher's baseline — no outbound transfers, no gas spend — so the
 *   absolute balance equals the deposit delta (S16's "balance delta").
 * - Every credited (address, asset) pair must appear in `balances`;
 *   a missing pair is refused loudly — silence would let an omitted
 *   sweep defeat the "every discrepancy reported" invariant.
 */
export function reconcile(
  state: WatcherState,
  balances: readonly BalanceObservation[],
): ReconcileReport {
  const observed = new Set(balances.map((b) => `${b.address}|${b.asset}`));
  for (const record of state.deposits.values()) {
    if (record.state !== 'credited') continue;
    if (!observed.has(`${record.to}|${record.asset}`)) {
      throw new Error(
        `reconcile is missing a balance observation for credited pair ` +
          `(${record.to}, ${record.asset})`,
      );
    }
  }
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
