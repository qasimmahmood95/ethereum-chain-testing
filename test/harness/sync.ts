// Drives the pure watcher from chain reads: the sync loop tests use to
// feed observations. Reorg *detection* is the watcher's job (an
// applyBlock ancestry-break outcome); this driver only reacts — it
// walks back to the common ancestor by comparing the watcher's stored
// hashes against the chain, then hands the watcher the replacement
// chain via reorgTo.

import type { ChainReader } from '../../src/rpc/adapter.js';
import { applyBlock, reorgTo, type WatcherState } from '../../src/watcher.js';
import type { Address, WatcherEvent } from '../../src/types.js';

export interface SyncResult {
  readonly state: WatcherState;
  readonly events: readonly WatcherEvent[];
}

/**
 * Catch the watcher up to the current chain tip, handling at most one
 * reorg per call (Anvil chains in tests are quiescent while syncing).
 */
export async function syncToTip(
  reader: ChainReader,
  state: WatcherState,
  firstHeight: bigint,
  watched: readonly Address[],
): Promise<SyncResult> {
  const events: WatcherEvent[] = [];
  const tip = await reader.getTipHeight();
  const from = state.tip === null ? firstHeight : state.tip.height + 1n;
  if (from > tip) return { state, events };

  for (const observation of await reader.observeBlocks(from, tip, watched)) {
    const result = applyBlock(state, observation);
    if (result.outcome === 'ancestry-break') {
      // Our tip is no longer canonical. Find the common ancestor by
      // comparing stored hashes with the chain, deepest first.
      let ancestor = state.tip === null ? firstHeight - 1n : state.tip.height;
      for (; ancestor >= firstHeight; ancestor--) {
        const ours = state.headers.get(ancestor);
        if (ours === undefined) continue;
        const theirs = await reader.getHeader(ancestor);
        if (theirs.hash === ours.hash) break;
      }
      const replacement = await reader.observeBlocks(
        ancestor + 1n,
        tip,
        watched,
      );
      const reorged = reorgTo(state, replacement);
      events.push(...reorged.events);
      return { state: reorged.state, events };
    }
    state = result.state;
    events.push(...result.events);
  }
  return { state, events };
}
