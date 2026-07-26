// Anvil's well-known dev accounts (unlocked node-side, so no private
// keys appear anywhere in this repo — CLAUDE.md hard rule 1). Signing
// happens inside Anvil via eth_sendTransaction.

import { createWalletClient, http, type Hex } from 'viem';
import { foundry } from 'viem/chains';

/** Anvil dev account #0 — the default deposit sender in tests. */
export const DEV_ACCOUNT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

/**
 * Send native ETH from an unlocked Anvil dev account. Returns the tx
 * hash. With automine off the tx sits in the mempool until mined.
 */
export async function sendEth(
  rpcUrl: string,
  args: { readonly to: Hex; readonly valueWei: bigint; readonly from?: Hex },
): Promise<Hex> {
  const wallet = createWalletClient({
    chain: foundry,
    transport: http(rpcUrl),
  });
  return wallet.sendTransaction({
    account: args.from ?? DEV_ACCOUNT_0,
    to: args.to,
    value: args.valueWei,
  });
}
