// ERC-20 Transfer-log decoding and minor-unit arithmetic. Pure — logs
// arrive as data, no viem, no I/O (CLAUDE.md rule 3). Amounts are
// bigint minor units end to end (rule 2): token decimals routinely put
// real balances past 2^53, where Number silently corrupts.

import { address, txHash, wei, type Address, type Wei } from './types.js';

/** keccak256("Transfer(address,address,uint256)") — the ERC-20 event. */
export const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** An EVM log as plain data, exactly as a node reports it. */
export interface RawLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly transactionHash: string;
  readonly logIndex: number;
}

export interface TokenTransfer {
  readonly token: Address;
  readonly from: Address;
  readonly to: Address;
  readonly value: Wei;
  readonly txHash: ReturnType<typeof txHash>;
  readonly logIndex: number;
}

const TOPIC_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const DATA_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** A 32-byte topic holding an address must be zero-padded on the left;
 * anything else is not an address-bearing Transfer topic. */
function topicToAddress(topic: string): Address | null {
  if (!TOPIC_PATTERN.test(topic)) return null;
  if (!/^0x0{24}/.test(topic)) return null;
  return address(`0x${topic.slice(26)}`);
}

/**
 * Decode one log as an ERC-20 Transfer. Returns null for anything that
 * is not a well-formed Transfer (wrong topic0, wrong arity, malformed
 * padding or data) — foreign events are skipped, never miscredited.
 */
export function decodeTransferLog(log: RawLog): TokenTransfer | null {
  if (log.topics.length !== 3) return null;
  if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return null;
  const from = topicToAddress(log.topics[1] ?? '');
  const to = topicToAddress(log.topics[2] ?? '');
  if (from === null || to === null) return null;
  if (!DATA_PATTERN.test(log.data)) return null;
  return {
    token: address(log.address),
    from,
    to,
    value: wei(BigInt(log.data)),
    txHash: txHash(log.transactionHash),
    logIndex: log.logIndex,
  };
}

/**
 * Parse a decimal string into minor units: "1.5" at 6 decimals is
 * 1500000n. Exact or refused — no floats anywhere.
 */
export function toMinorUnits(decimal: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new Error(`not a decimals value: ${decimals}`);
  }
  const match = /^(\d+)(?:\.(\d+))?$/.exec(decimal);
  if (match === null) {
    throw new Error(`not a decimal amount: ${decimal}`);
  }
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) {
    throw new Error(
      `${decimal} has more fractional digits than ${decimals} decimals`,
    );
  }
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, '0') || '0')
  );
}

/** Canonical decimal rendering of minor units (no trailing zeros). */
export function fromMinorUnits(units: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new Error(`not a decimals value: ${decimals}`);
  }
  if (units < 0n) {
    throw new Error(`negative minor units: ${units}`);
  }
  const base = 10n ** BigInt(decimals);
  const whole = units / base;
  const fraction = (units % base).toString().padStart(decimals, '0');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed.length > 0 ? `${whole}.${trimmed}` : whole.toString();
}
