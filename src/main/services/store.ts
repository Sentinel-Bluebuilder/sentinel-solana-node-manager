import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppEvent, DeployedNode, WalletState } from '../../shared/types';

/**
 * Minimal on-disk JSON store.
 *
 * Secrets policy:
 *   - App wallet mnemonic lives at userData/wallet.secret, encrypted by
 *     Electron safeStorage (OS keychain).
 *   - Per-node operator mnemonics live on the node itself (in its own
 *     keyring). If the user opts to back one up in the app, it ends up in
 *     store.nodeBackups, also encrypted by safeStorage.
 *   - SSH credentials are never persisted.
 *
 * Everything else is fine to keep in plain JSON.
 */

interface StoreShape {
  wallet: WalletState | null;
  nodes: DeployedNode[];
  events: AppEvent[];
  logs: Record<string, string[]>;
  /** Base64-encoded safeStorage blobs keyed by node id. Nullable by design. */
  nodeBackups: Record<string, string | undefined>;
  /** Voucher channels opened by "Test node", swept back by sweepTestChannels(). */
  testChannels?: Array<{ channel: string; node: string; openedAt: string }>;
  /** True when a sweep closed channels but withdraw_user_balance failed; the next sweep retries it. */
  testChannelRefundPending?: boolean;
  /**
   * Node id → key owner for nodes whose record has been dropped. A node's directory
   * on its host outlives the record whenever removal's host cleanup could not run,
   * and without the owner address such a directory cannot be proven empty, so it
   * could never be safely deleted. Secrets are never kept here, only the address.
   */
  retiredNodeOwners?: Record<string, string>;
  /**
   * On-chain node addresses the operator follows read-only: nodes this app did not
   * deploy (no key, no host), so it can show their chain state but not manage them.
   */
  watchedNodes?: Array<{ address: string; label?: string; addedAt: string }>;
}

const DEFAULT_STORE: StoreShape = {
  wallet: null,
  nodes: [],
  events: [],
  logs: {},
  nodeBackups: {},
};

let cached: StoreShape | null = null;

function storePath(): string {
  return path.join(app.getPath('userData'), 'store.json');
}

export async function readStore(): Promise<StoreShape> {
  if (cached) return cached;
  try {
    const raw = await fs.readFile(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    cached = {
      wallet: parsed.wallet ?? null,
      nodes: parsed.nodes ?? [],
      events: parsed.events ?? [],
      logs: parsed.logs ?? {},
      nodeBackups: parsed.nodeBackups ?? {},
      testChannels: parsed.testChannels ?? [],
      testChannelRefundPending: parsed.testChannelRefundPending ?? false,
      retiredNodeOwners: parsed.retiredNodeOwners ?? {},
      watchedNodes: parsed.watchedNodes ?? [],
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`store.json unreadable, starting empty: ${(err as Error).message}\n`);
    }
    cached = structuredClone(DEFAULT_STORE);
  }
  return cached;
}

// Writes run one at a time (Q0408). Two saves in the same millisecond used to share one
// temp name (pid + Date.now()): one rename failed ENOENT, and two writers could interleave
// in that one file. Each write now has its own temp file and waits for the previous write.
let writeSeq = 0;
let writeChain: Promise<void> = Promise.resolve();

export function writeStore(next: StoreShape): Promise<void> {
  cached = next;
  const run = writeChain.then(() => persist(next));
  // Keep the chain alive after a failed write; the caller still gets the error from `run`.
  writeChain = run.catch((err: unknown) => {
    process.stderr.write(`store.json write failed: ${(err as Error).message}\n`);
  });
  return run;
}

async function persist(next: StoreShape): Promise<void> {
  const target = storePath();
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  // Atomic write: serialize to a sibling temp file first, then rename. A
  // crash mid-write therefore cannot leave `store.json` truncated — the
  // previous good copy stays intact until the rename completes.
  writeSeq += 1;
  const tmp = `${target}.${process.pid}.${Date.now()}.${writeSeq}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  try {
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch((rmErr: unknown) => {
      process.stderr.write(`store temp cleanup failed (${tmp}): ${(rmErr as Error).message}\n`);
    });
    throw err;
  }
}
