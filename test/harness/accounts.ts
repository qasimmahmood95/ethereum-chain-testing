// Anvil's well-known dev accounts (unlocked node-side, so no private
// keys appear anywhere in this repo — CLAUDE.md hard rule 1). Signing
// happens inside Anvil via eth_sendTransaction.

import { createWalletClient, http, type Hex } from 'viem';
import { mnemonicToAccount, type HDAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

/** Anvil dev account #0 — the default deposit sender in tests. */
export const DEV_ACCOUNT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

/** Anvil's canonical, public dev mnemonic. Not a secret by design. */
export const ANVIL_MNEMONIC =
  'test test test test test test test test test test test junk';

/**
 * A locally-signing dev account (M4+ broadcaster tests need raw bytes
 * to rebroadcast). Same keys Anvil funds and unlocks at startup.
 */
export function devAccount(index: number): HDAccount {
  return mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index });
}

export interface SendEthArgs {
  readonly to: Hex;
  readonly valueWei: bigint;
  readonly from?: Hex;
  /**
   * Pinning nonce + fees makes the tx bytes — and therefore the tx
   * hash — deterministic across a snapshot/revert, which is how S5
   * re-includes the *same* tx on the replacement branch.
   */
  readonly nonce?: number;
  readonly maxFeePerGas?: bigint;
  readonly maxPriorityFeePerGas?: bigint;
}

/**
 * Send native ETH from an unlocked Anvil dev account. Returns the tx
 * hash. With automine off the tx sits in the mempool until mined.
 */
export async function sendEth(rpcUrl: string, args: SendEthArgs): Promise<Hex> {
  const wallet = createWalletClient({
    chain: foundry,
    transport: http(rpcUrl),
  });
  return wallet.sendTransaction({
    account: args.from ?? DEV_ACCOUNT_0,
    to: args.to,
    value: args.valueWei,
    gas: 21_000n,
    ...(args.nonce !== undefined ? { nonce: args.nonce } : {}),
    ...(args.maxFeePerGas !== undefined
      ? { maxFeePerGas: args.maxFeePerGas }
      : {}),
    ...(args.maxPriorityFeePerGas !== undefined
      ? { maxPriorityFeePerGas: args.maxPriorityFeePerGas }
      : {}),
  });
}
