import {
  ComputeBudgetProgram,
  Connection,
  Transaction,
  type Keypair,
  type TransactionInstruction,
} from '@solana/web3.js';
import { DEVNET_GENESIS_HASH } from './chain';
import { getSettings } from './settings';
import { log } from './logger';
import { rpcHostOf, rpcIsLocalOnly } from './validate';
import type { ChainHealth } from '../../shared/types';

/**
 * Solana JSON-RPC plumbing (replaces the Cosmos sentinel-client.ts).
 *
 *   • pickRPC() returns the first Settings RPC whose genesis hash is devnet's,
 *     probed inside a 4 s budget and cached 30 s.
 *   • connection() returns a Connection on that RPC.
 *   • sendTx() signs, sends and confirms with a priority fee, retrying on 429,
 *     transient network errors and blockhash expiry (the public devnet RPC
 *     rate-limits; one 429 must never fail a user action).
 *   • healthAll() feeds the Settings screen's per-RPC reachability.
 */

const PROBE_TIMEOUT_MS = 4_000;
const PROBE_CACHE_TTL_MS = 30_000;
const RPC_CONNECT_TIMEOUT_MS = 6_000;
const RPC_QUERY_TIMEOUT_MS = 12_000;
const RPC_BROADCAST_TIMEOUT_MS = 90_000;

export { RPC_CONNECT_TIMEOUT_MS, RPC_QUERY_TIMEOUT_MS, RPC_BROADCAST_TIMEOUT_MS };

export async function withRpcTimeout<T>(op: () => Promise<T>, ms: number, label: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `RPC '${label}' timed out after ${Math.round(ms / 1000)}s. ` +
            `The endpoint may be unreachable — check Settings → RPC list.`,
        ),
      );
    }, ms);
    op().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Errors worth retrying: rate limits, flaky sockets, expired blockhashes. */
export function isTransientRpcError(msg: string): boolean {
  return /429|Too Many Requests|timed out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|socket hang up|fetch failed|getaddrinfo|EAI_AGAIN|503|502|Blockhash not found|block height exceeded|TransactionExpired/i.test(
    msg,
  );
}

/** Retry `op` with exponential backoff on transient RPC errors. */
export async function withRetry<T>(op: () => Promise<T>, label: string, attempts = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await op();
    } catch (err) {
      last = err;
      const msg = (err as Error).message ?? String(err);
      if (!isTransientRpcError(msg) || i === attempts - 1) break;
      const delay = Math.min(8_000, 750 * 2 ** i);
      log.debug('rpc retry', { label, attempt: i + 1, delay, err: msg.slice(0, 160) });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw last;
}

interface CachedHealth {
  ok: boolean;
  at: number;
  chainId?: string;
  blockHeight?: number;
  latencyMs?: number;
  error?: string;
}

const healthCache = new Map<string, CachedHealth>();

export async function pickRPC(opts: { forRemoteHost?: boolean } = {}): Promise<string> {
  const { rpcUrls } = await getSettings();
  // A node or client on a VPS cannot reach this machine's loopback or LAN/VPC addresses, so a
  // gateway on 10.x/192.168.x serves only what runs here (FINAL check 2026-11-08: the remote
  // node got http://10.0.0.5 and could not read the program config).
  const usable = opts.forRemoteHost ? rpcUrls.filter((u) => !rpcIsLocalOnly(u)) : rpcUrls;
  if (opts.forRemoteHost && !usable.length) {
    throw new Error(
      `Every RPC server in Settings is a local or private-network address (${rpcUrls.map(rpcHostOf).join(', ')}), which a node on another server cannot reach. Add a public https:// RPC in Settings.`,
    );
  }
  for (const url of usable) {
    if (await isHealthy(url)) return url;
  }
  throw new Error(
    `Could not connect to Solana devnet. We tried these servers and none responded: ${rpcUrls.join(', ')}. Please check your internet connection, or update the server list in Settings.`,
  );
}

export async function connection(): Promise<Connection> {
  const url = await pickRPC();
  return new Connection(url, { commitment: 'confirmed', disableRetryOnRateLimit: true });
}

async function isHealthy(url: string): Promise<boolean> {
  const cached = healthCache.get(url);
  if (cached && Date.now() - cached.at < PROBE_CACHE_TTL_MS && cached.ok) return true;
  const start = Date.now();
  try {
    const conn = new Connection(url, { commitment: 'confirmed', disableRetryOnRateLimit: true });
    const genesis = await withRetry(
      () => withRpcTimeout(() => conn.getGenesisHash(), PROBE_TIMEOUT_MS, `genesis ${url}`),
      `genesis ${url}`,
      3,
    );
    const slot = await withRetry(
      () => withRpcTimeout(() => conn.getSlot(), PROBE_TIMEOUT_MS, `slot ${url}`),
      `slot ${url}`,
      3,
    );
    const ok = genesis === DEVNET_GENESIS_HASH;
    healthCache.set(url, {
      ok,
      at: Date.now(),
      chainId: ok ? 'devnet' : genesis,
      blockHeight: slot,
      latencyMs: Date.now() - start,
      error: ok ? undefined : `not devnet: genesis ${genesis}`,
    });
    return ok;
  } catch (err) {
    log.debug('RPC probe failed', { url, err: (err as Error).message });
    healthCache.set(url, { ok: false, at: Date.now(), error: (err as Error).message, latencyMs: Date.now() - start });
    return false;
  }
}

export async function healthAll(): Promise<ChainHealth[]> {
  const { rpcUrls } = await getSettings();
  const out: ChainHealth[] = [];
  for (const url of rpcUrls) {
    await isHealthy(url);
    const c = healthCache.get(url);
    out.push({
      rpcUrl: url,
      reachable: !!c?.ok,
      latencyMs: c?.latencyMs,
      chainId: c?.chainId,
      blockHeight: c?.blockHeight,
      error: c?.error,
    });
  }
  return out;
}

export function invalidateHealthCache(): void {
  healthCache.clear();
}

export interface SentTx {
  signature: string;
  slot: number;
  feeLamports: number;
}

/**
 * Build, sign, send and confirm a transaction. A fresh blockhash is fetched
 * on every attempt, so a retry after expiry re-signs rather than replaying a
 * dead transaction. A signature that DID land is detected before retrying,
 * so a retry never double-spends.
 */
export async function sendTx(
  instructions: TransactionInstruction[],
  feePayer: Keypair,
  extraSigners: Keypair[] = [],
  label = 'tx',
): Promise<SentTx> {
  const { priorityFeeMicroLamports } = await getSettings();
  const conn = await connection();
  const ixs = [...instructions];
  if (priorityFeeMicroLamports > 0) {
    ixs.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }));
  }

  let lastErr: unknown;
  let lastSig: string | undefined;
  let lastValidHeight: number | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (lastSig) {
      // A previous attempt may have landed even though confirmation failed.
      const st = await withRetry(() => conn.getSignatureStatus(lastSig!, { searchTransactionHistory: true }), 'sigStatus').catch(
        (err: unknown) => {
          log.debug('signature status lookup failed', { label, err: (err as Error).message });
          return null;
        },
      );
      if (st?.value && !st.value.err && st.value.confirmationStatus) {
        return finish(conn, lastSig, st.context.slot);
      }
    }
    try {
      const { blockhash, lastValidBlockHeight } = await withRetry(
        () => withRpcTimeout(() => conn.getLatestBlockhash('confirmed'), RPC_QUERY_TIMEOUT_MS, 'getLatestBlockhash'),
        'getLatestBlockhash',
      );
      const tx = new Transaction({ feePayer: feePayer.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
      tx.sign(feePayer, ...extraSigners);
      const sig = await withRetry(
        () =>
          withRpcTimeout(
            () => conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 }),
            RPC_QUERY_TIMEOUT_MS,
            `send ${label}`,
          ),
        `send ${label}`,
      );
      lastSig = sig;
      lastValidHeight = lastValidBlockHeight;
      const conf = await withRpcTimeout(
        () => conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed'),
        RPC_BROADCAST_TIMEOUT_MS,
        `confirm ${label}`,
      );
      if (conf.value.err) {
        throw new Error(`Transaction ${sig} failed on chain: ${JSON.stringify(conf.value.err)}`);
      }
      return finish(conn, sig, conf.context.slot);
    } catch (err) {
      lastErr = err;
      const msg = (err as Error).message ?? String(err);
      if (!isTransientRpcError(msg)) throw err;
      log.warn('sendTx transient failure, retrying', { label, attempt: attempt + 1, err: msg.slice(0, 200) });
      if (lastSig && lastValidHeight !== undefined) {
        // Never re-sign while the previous transaction can still land: wait until
        // its blockhash has expired (then the status check at the top of the loop
        // is authoritative), so a slow confirm cannot turn into a double spend.
        await waitForExpiry(conn, lastValidHeight);
      }
      await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function waitForExpiry(conn: Connection, lastValidBlockHeight: number): Promise<void> {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const h = await withRetry(() => conn.getBlockHeight('confirmed'), 'getBlockHeight', 3).catch((err: unknown) => {
      log.debug('getBlockHeight failed while waiting for expiry', { err: (err as Error).message });
      return undefined;
    });
    if (h !== undefined && h > lastValidBlockHeight) return;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  log.warn('blockhash expiry wait timed out; proceeding to the status check');
}

async function finish(conn: Connection, signature: string, slot: number): Promise<SentTx> {
  let feeLamports = 0;
  try {
    const tx = await withRetry(
      () => conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }),
      'getTransaction',
      3,
    );
    feeLamports = tx?.meta?.fee ?? 0;
  } catch (err) {
    log.debug('fee lookup failed (non-fatal)', { signature, err: (err as Error).message });
  }
  return { signature, slot, feeLamports };
}
