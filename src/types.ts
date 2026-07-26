// Core domain types. Pure data — no I/O, no viem (CLAUDE.md rule 3).
// All amounts are bigint minor units; `number` never holds an amount
// (rule 2). Confirmation depth is explicit policy (rule 5).

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type Hex = `0x${string}`;

export type Address = Brand<Hex, 'Address'>;
export type BlockHash = Brand<Hex, 'BlockHash'>;
export type TxHash = Brand<Hex, 'TxHash'>;

/** Amount in wei (or token minor units from M6 on). Always bigint. */
export type Wei = Brand<bigint, 'Wei'>;

/**
 * Identity of a deposit. Native ETH deposits are keyed by tx hash; M6
 * extends the key to (txHash, logIndex) for token transfers.
 */
export type DepositId = Brand<string, 'DepositId'>;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** Parse and normalize (lowercase) an address so comparisons are exact. */
export function address(value: string): Address {
  if (!ADDRESS_PATTERN.test(value)) {
    throw new Error(`not an address: ${value}`);
  }
  return value.toLowerCase() as Address;
}

export function blockHash(value: string): BlockHash {
  if (!HASH_PATTERN.test(value)) {
    throw new Error(`not a 32-byte hash: ${value}`);
  }
  return value.toLowerCase() as BlockHash;
}

export function txHash(value: string): TxHash {
  if (!HASH_PATTERN.test(value)) {
    throw new Error(`not a 32-byte hash: ${value}`);
  }
  return value.toLowerCase() as TxHash;
}

export function wei(value: bigint): Wei {
  if (value < 0n) {
    throw new Error(`negative amount: ${value}`);
  }
  return value as Wei;
}

export function nativeDepositId(hash: TxHash): DepositId {
  return hash as string as DepositId;
}

/** Confirmation depth N is policy, passed in explicitly — never a default. */
export interface WatcherConfig {
  readonly confirmationDepth: number;
}

export interface BlockHeader {
  readonly height: bigint;
  readonly hash: BlockHash;
  readonly parentHash: BlockHash;
}

/** A deposit as observed inside one specific block. */
export interface DepositObservation {
  readonly txHash: TxHash;
  readonly to: Address;
  readonly amount: Wei;
}

/** Everything the watcher learns from one new canonical block. */
export interface BlockObservation {
  readonly header: BlockHeader;
  readonly deposits: readonly DepositObservation[];
}

/**
 * seen: included on the canonical chain, below confirmation depth.
 * credited: reached depth N on the canonical chain; funds available.
 * Removal on reorg is an event, not a state — a reorged-out deposit
 * leaves the record set entirely (a later re-inclusion is a fresh
 * sighting).
 */
export type DepositState = 'seen' | 'credited';

export interface DepositRecord {
  readonly id: DepositId;
  readonly txHash: TxHash;
  readonly to: Address;
  readonly amount: Wei;
  readonly inclusionHeight: bigint;
  readonly inclusionHash: BlockHash;
  readonly state: DepositState;
}

export type WatcherEvent =
  | { readonly type: 'deposit-seen'; readonly deposit: DepositRecord }
  | {
      readonly type: 'deposit-credited';
      readonly deposit: DepositRecord;
      readonly confirmations: bigint;
    }
  | {
      // The deposit's inclusion block left the canonical chain. A later
      // re-inclusion is a fresh sighting.
      readonly type: 'deposit-removed';
      readonly deposit: DepositRecord;
      readonly reason: 'reorged-out';
    }
  | {
      // A reorg deeper than N invalidated an already-credited deposit.
      // Funds the books counted no longer exist on chain — never silent
      // (S7); reconciliation re-checks this in M6.
      readonly type: 'alarm';
      readonly kind: 'credited-deposit-invalidated';
      readonly deposit: DepositRecord;
    };
