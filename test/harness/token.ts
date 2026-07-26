// Deploy and drive the TestToken fixture (contracts/) from Anvil's
// unlocked dev accounts. The committed artifact is the only build
// input — CI never compiles Solidity (rule 4).

import { readFileSync } from 'node:fs';
import {
  createWalletClient,
  http,
  type Abi,
  type Hex,
  type WalletClient,
} from 'viem';
import { foundry } from 'viem/chains';
import { DEV_ACCOUNT_0 } from './accounts.js';
import type { AnvilInstance } from './anvil.js';

const artifact = JSON.parse(
  readFileSync(
    new URL('../../contracts/out/TestToken.json', import.meta.url),
    'utf8',
  ),
) as { abi: Abi; bytecode: Hex };

export interface TokenHandle {
  readonly address: Hex;
  readonly decimals: number;
}

function wallet(anvil: AnvilInstance): WalletClient {
  return createWalletClient({ chain: foundry, transport: http(anvil.rpcUrl) });
}

/** Deploy a fresh token (mines one block; automine may be off). */
export async function deployToken(
  anvil: AnvilInstance,
  options: { readonly decimals: number; readonly symbol?: string },
): Promise<TokenHandle> {
  const hash = await wallet(anvil).deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    account: DEV_ACCOUNT_0,
    chain: foundry,
    args: [
      `Test Token ${options.decimals}`,
      options.symbol ?? `TT${options.decimals}`,
      options.decimals,
    ],
  });
  await anvil.testClient.mine({ blocks: 1 });
  const receipt = await anvil.publicClient.getTransactionReceipt({ hash });
  if (receipt.contractAddress == null) {
    throw new Error('token deployment produced no contract address');
  }
  return { address: receipt.contractAddress, decimals: options.decimals };
}

/** Mint to an address (sends the tx; caller controls mining). */
export async function mintToken(
  anvil: AnvilInstance,
  token: TokenHandle,
  to: Hex,
  amount: bigint,
): Promise<Hex> {
  return wallet(anvil).writeContract({
    address: token.address,
    abi: artifact.abi,
    functionName: 'mint',
    args: [to, amount],
    account: DEV_ACCOUNT_0,
    chain: foundry,
  });
}

/** Transfer from dev account 0 (sends the tx; caller mines). */
export async function transferToken(
  anvil: AnvilInstance,
  token: TokenHandle,
  to: Hex,
  amount: bigint,
): Promise<Hex> {
  return wallet(anvil).writeContract({
    address: token.address,
    abi: artifact.abi,
    functionName: 'transfer',
    args: [to, amount],
    account: DEV_ACCOUNT_0,
    chain: foundry,
  });
}

/** Several transfers in one tx (S14). Caller mines. */
export async function batchTransferToken(
  anvil: AnvilInstance,
  token: TokenHandle,
  to: readonly Hex[],
  amounts: readonly bigint[],
): Promise<Hex> {
  return wallet(anvil).writeContract({
    address: token.address,
    abi: artifact.abi,
    functionName: 'batchTransfer',
    args: [to, amounts],
    account: DEV_ACCOUNT_0,
    chain: foundry,
  });
}
