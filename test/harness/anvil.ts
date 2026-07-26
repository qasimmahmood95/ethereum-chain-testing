import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicClient, createTestClient, http, type Hex } from 'viem';
import { foundry } from 'viem/chains';
import { afterEach, beforeEach } from 'vitest';

/** The chain id Anvil serves in its default dev configuration. */
export const ANVIL_CHAIN_ID = 31337;

const ANVIL_COMMAND = process.platform === 'win32' ? 'anvil.exe' : 'anvil';
const LISTEN_PATTERN = /Listening on (?:127\.0\.0\.1|\[::1\]):(\d+)/;
const STARTUP_TIMEOUT_MS = 15_000;
const SHUTDOWN_GRACE_MS = 5_000;

function makeClients(rpcUrl: string) {
  // cacheTime 0: tests assert on chain state immediately after mutating it,
  // so a cached block number would make assertions nondeterministic.
  return {
    testClient: createTestClient({
      chain: foundry,
      mode: 'anvil',
      transport: http(rpcUrl),
      cacheTime: 0,
    }),
    publicClient: createPublicClient({
      chain: foundry,
      transport: http(rpcUrl),
      cacheTime: 0,
    }),
  };
}

export type AnvilTestClient = ReturnType<typeof makeClients>['testClient'];
export type AnvilPublicClient = ReturnType<typeof makeClients>['publicClient'];

export interface AnvilInstance {
  readonly rpcUrl: string;
  readonly port: number;
  /** First line of `anvil --version`, for CI logs. */
  readonly version: string;
  readonly testClient: AnvilTestClient;
  readonly publicClient: AnvilPublicClient;
  stop(): Promise<void>;
}

export interface StartAnvilOptions {
  /** Extra CLI arguments, e.g. ['--no-mining'] for mempool suites. */
  readonly args?: readonly string[];
  /** Listen-banner deadline. Fork mode fetches remote chain metadata
   * before listening, so fork suites pass a larger budget. */
  readonly startupTimeoutMs?: number;
}

/**
 * Spawn a fresh Anvil on an OS-assigned free port, wait for its RPC to come
 * up and refuse to proceed unless it serves chain id 31337. Each suite gets
 * its own instance (per-suite isolation); suites that also want per-test
 * isolation opt in via `useSnapshotReset`.
 */
export async function startAnvil(
  options: StartAnvilOptions = {},
): Promise<AnvilInstance> {
  const proc = spawn(ANVIL_COMMAND, ['--port', '0', ...(options.args ?? [])], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const collect = (chunk: string) => (output += chunk);
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', collect);
  proc.stderr.on('data', collect);

  const port = await waitForListenPort(
    proc,
    () => output,
    options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
  );
  // Startup output captured; from here on discard, or a chatty node would
  // grow the buffer unboundedly. resume() keeps the pipes draining so
  // anvil never blocks on a full stdout pipe.
  proc.stdout.off('data', collect).resume();
  proc.stderr.off('data', collect).resume();

  const rpcUrl = `http://127.0.0.1:${port}`;
  const { testClient, publicClient } = makeClients(rpcUrl);

  // If the vitest worker dies before afterAll runs, don't orphan the node
  // (mostly a Windows dev-machine concern). 'exit' handlers must be sync.
  const killOnExit = () => proc.kill('SIGKILL');
  process.once('exit', killOnExit);

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (!stopping) {
      process.off('exit', killOnExit);
      stopping = terminate(proc);
    }
    return stopping;
  };

  let chainId: number;
  try {
    chainId = await withRetry(() => publicClient.getChainId());
  } catch (cause) {
    await stop();
    throw new Error(`anvil RPC never became ready on ${rpcUrl}`, { cause });
  }
  if (chainId !== ANVIL_CHAIN_ID) {
    await stop();
    throw new Error(
      `refusing to run: expected chain id ${ANVIL_CHAIN_ID} (Anvil dev chain), got ${chainId}`,
    );
  }

  return {
    rpcUrl,
    port,
    version: anvilVersion(),
    testClient,
    publicClient,
    stop,
  };
}

/**
 * Opt-in per-test isolation: snapshot before each test, revert after it.
 * Call inside a `describe` whose `beforeAll` started the instance.
 * `evm_revert` consumes the snapshot, so a fresh one is taken every test.
 */
export function useSnapshotReset(anvil: () => AnvilInstance): void {
  // Shared hook state: not safe under describe.concurrent, which M1..M8
  // suites never use (each suite owns one Anvil; tests run sequentially).
  let snapshotId: Hex | undefined;

  beforeEach(async () => {
    snapshotId = await anvil().testClient.snapshot();
  });

  afterEach(async () => {
    // If the beforeEach snapshot failed, there is nothing to revert;
    // reverting a stale id here would only mask the original error.
    if (snapshotId === undefined) return;
    const id = snapshotId;
    snapshotId = undefined;
    // Anvil answers evm_revert with a boolean; viem's schema types it void.
    const reverted = (await anvil().testClient.request({
      method: 'evm_revert',
      params: [id],
    })) as unknown as boolean;
    if (reverted !== true) {
      throw new Error(`evm_revert(${id}) returned false`);
    }
  });
}

async function waitForListenPort(
  proc: ChildProcess,
  getOutput: () => string,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let failure: Error | undefined;

  proc.once('error', (error: NodeJS.ErrnoException) => {
    failure =
      error.code === 'ENOENT'
        ? new Error(
            `'${ANVIL_COMMAND}' not found on PATH — install Foundry (https://getfoundry.sh)`,
          )
        : error;
  });
  proc.once('exit', (code) => {
    failure ??= new Error(
      `anvil exited (code ${String(code)}) before listening:\n${getOutput()}`,
    );
  });

  for (;;) {
    if (failure) throw failure;
    const port = LISTEN_PATTERN.exec(getOutput())?.[1];
    if (port !== undefined) return Number(port);
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error(
        `anvil did not report a listening port within ${timeoutMs}ms:\n${getOutput()}`,
      );
    }
    await delay(10);
  }
}

async function terminate(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = once(proc, 'exit');
  proc.kill('SIGTERM');
  const graceful = await Promise.race([
    exited.then(() => true),
    delay(SHUTDOWN_GRACE_MS, false, { ref: false }),
  ]);
  if (!graceful) {
    proc.kill('SIGKILL');
    await exited;
  }
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const attempts = 20;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === attempts) throw error;
      await delay(100);
    }
  }
}

function anvilVersion(): string {
  const result = spawnSync(ANVIL_COMMAND, ['--version'], { encoding: 'utf8' });
  return result.stdout?.split('\n', 1)[0]?.trim() || 'anvil (version unknown)';
}
