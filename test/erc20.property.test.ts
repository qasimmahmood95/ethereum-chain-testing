// Property tests for the pure ERC-20 layer (the reconciliation-testing
// mindset applied to token decimals): minor-unit round-trips and log
// slicing must be exact far past 2^53, where Number silently corrupts.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  decodeTransferLog,
  fromMinorUnits,
  toMinorUnits,
  TRANSFER_TOPIC,
  type RawLog,
} from '../src/erc20.js';

const hex40 = fc
  .bigInt({ min: 0n, max: 2n ** 160n - 1n })
  .map((v) => v.toString(16).padStart(40, '0'));

function encodeTransfer(
  token: string,
  from: string,
  to: string,
  value: bigint,
  logIndex: number,
): RawLog {
  return {
    address: `0x${token}`,
    topics: [
      TRANSFER_TOPIC,
      `0x${'0'.repeat(24)}${from}`,
      `0x${'0'.repeat(24)}${to}`,
    ],
    data: `0x${value.toString(16).padStart(64, '0')}`,
    transactionHash: `0x${'ab'.repeat(32)}`,
    logIndex,
  };
}

describe('minor-unit conversion (property)', () => {
  it('round-trips exactly for any value and decimals, past 2^53', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 2n ** 128n }),
        fc.integer({ min: 0, max: 18 }),
        (units, decimals) => {
          expect(toMinorUnits(fromMinorUnits(units, decimals), decimals)).toBe(
            units,
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  it('round-trips in the specifically dangerous band just past 2^53', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 2n ** 53n + 1n, max: 2n ** 60n }),
        fc.integer({ min: 0, max: 18 }),
        (units, decimals) => {
          expect(toMinorUnits(fromMinorUnits(units, decimals), decimals)).toBe(
            units,
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  it('refuses too many fractional digits and malformed strings', () => {
    expect(() => toMinorUnits('1.1234567', 6)).toThrow(/fractional/);
    expect(() => toMinorUnits('1,5', 6)).toThrow(/not a decimal/);
    expect(() => toMinorUnits('-1', 6)).toThrow(/not a decimal/);
    expect(toMinorUnits('1.5', 6)).toBe(1_500_000n);
    expect(fromMinorUnits(1_500_000n, 6)).toBe('1.5');
  });
});

describe('Transfer log decoding (property)', () => {
  it('decodes any well-formed Transfer exactly, past 2^53', () => {
    fc.assert(
      fc.property(
        hex40,
        hex40,
        hex40,
        fc.bigInt({ min: 0n, max: 2n ** 256n - 1n }),
        fc.integer({ min: 0, max: 1000 }),
        (token, from, to, value, logIndex) => {
          const decoded = decodeTransferLog(
            encodeTransfer(token, from, to, value, logIndex),
          );
          expect(decoded).not.toBeNull();
          expect(decoded?.value).toBe(value);
          expect(decoded?.to).toBe(`0x${to.toLowerCase()}`);
          expect(decoded?.from).toBe(`0x${from.toLowerCase()}`);
          expect(decoded?.token).toBe(`0x${token.toLowerCase()}`);
          expect(decoded?.logIndex).toBe(logIndex);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('rejects non-Transfer and malformed logs', () => {
    const good = encodeTransfer(
      '11'.repeat(20),
      '22'.repeat(20),
      '33'.repeat(20),
      5n,
      0,
    );
    expect(decodeTransferLog(good)).not.toBeNull();
    // Wrong topic0.
    expect(
      decodeTransferLog({
        ...good,
        topics: [`0x${'ff'.repeat(32)}`, good.topics[1]!, good.topics[2]!],
      }),
    ).toBeNull();
    // Wrong arity (ERC-721 Transfer has 4 topics).
    expect(
      decodeTransferLog({ ...good, topics: [...good.topics, good.topics[1]!] }),
    ).toBeNull();
    // Non-zero padding in an address topic.
    expect(
      decodeTransferLog({
        ...good,
        topics: [good.topics[0]!, `0x${'11'.repeat(32)}`, good.topics[2]!],
      }),
    ).toBeNull();
    // Malformed data.
    expect(decodeTransferLog({ ...good, data: '0x01' })).toBeNull();
  });
});
