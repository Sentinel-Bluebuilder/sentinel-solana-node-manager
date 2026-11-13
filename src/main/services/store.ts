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
  testChannels?: Array<{ channel: string; node: string; openedAt: string; closeMaturesAt?: string }>;
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
  /**
   * Containers of removed LOCAL nodes that could not be deleted because Docker was down
   * (fix G). They cannot run while Docker is down; the poller deletes them once it is up.
   */
  staleLocalContainers?: Array<{ nodeId: string; runtimeId?: string; at: string }>;
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

// Callers at startup race before `cached` is set; they share one load, so a damaged file is
// recovered (and kept aside) once, not once per caller (NM-C9 T8: two .damaged-* copies 1 ms apart).
let loading: Promise<StoreShape> | null = null;

export async function readStore(): Promise<StoreShape> {
  if (cached) return cached;
  if (!loading) loading = loadOrRecover().finally(() => (loading = null));
  return loading;
}

async function loadOrRecover(): Promise<StoreShape> {
  if (cached) return cached;
  try {
    cached = await loadStoreFile(storePath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      cached = structuredClone(DEFAULT_STORE);
      return cached;
    }
    // T8 (0.3.1): an unreadable store used to start empty and the next save overwrote it,
    // losing every node record (bonds and keys on hosts the app no longer knew about).
    // Keep the damaged file aside, restore the rolling backup, and tell the user.
    const target = storePath();
    const kept = `${target}.damaged-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const keptOk = await fs.copyFile(target, kept).then(
      () => true,
      (e: unknown) => (process.stderr.write(`could not keep the damaged store.json aside: ${(e as Error).message}\n`), false),
    );
    let restored = false;
    try {
      cached = await loadStoreFile(backupPath());
      restored = true;
    } catch (bakErr) {
      process.stderr.write(`store.json backup unusable: ${(bakErr as Error).message}\n`);
      cached = structuredClone(DEFAULT_STORE);
    }
    // The file on disk is the damaged one: the first save must not copy it over the backup.
    skipNextBackup = true;
    process.stderr.write(`store.json unreadable (${(err as Error).message}); ${restored ? 'restored the backup' : 'starting empty'}\n`);
    cached.events = [
      {
        id: `store-recovered-${Date.now()}`,
        kind: 'store-recovered',
        title: restored ? 'App data was damaged and has been restored from a backup' : 'App data was damaged and could not be restored',
        subtitle: `${restored ? 'Changes from the last few minutes may be missing.' : 'Your nodes keep running, but this app no longer lists them. Do not delete the damaged file: it holds the node keys.'} The damaged file was ${keptOk ? `kept as ${path.basename(kept)}` : 'NOT kept (see app.log)'}.`,
        timestamp: new Date().toISOString(),
      },
      ...cached.events,
    ];
  }
  return cached;
}

async function loadStoreFile(file: string): Promise<StoreShape> {
  const raw = await fs.readFile(file, 'utf8');
  const parsed = JSON.parse(raw) as Partial<StoreShape> | null;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a store object');
  if (parsed.nodes !== undefined && !Array.isArray(parsed.nodes)) throw new Error('nodes is not a list');
  return {
    wallet: parsed.wallet ?? null,
    nodes: parsed.nodes ?? [],
    events: parsed.events ?? [],
    logs: parsed.logs ?? {},
    nodeBackups: parsed.nodeBackups ?? {},
    testChannels: parsed.testChannels ?? [],
    testChannelRefundPending: parsed.testChannelRefundPending ?? false,
    retiredNodeOwners: parsed.retiredNodeOwners ?? {},
    watchedNodes: parsed.watchedNodes ?? [],
    staleLocalContainers: parsed.staleLocalContainers ?? [],
  };
}

function backupPath(): string {
  return `${storePath()}.bak`;
}

// Rolling backup: before a save replaces store.json, the previous copy goes to store.json.bak
// at most every 5 minutes (and on the first save of a session).
const BACKUP_EVERY_MS = 5 * 60_000;
let lastBackupAt = 0;
let skipNextBackup = false;

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
  if (skipNextBackup) {
    skipNextBackup = false;
    lastBackupAt = Date.now();
  } else if (Date.now() - lastBackupAt >= BACKUP_EVERY_MS) {
    lastBackupAt = Date.now();
    await fs.copyFile(target, backupPath()).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') process.stderr.write(`store.json backup failed: ${(err as Error).message}\n`);
    });
  }
  try {
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch((rmErr: unknown) => {
      process.stderr.write(`store temp cleanup failed (${tmp}): ${(rmErr as Error).message}\n`);
    });
    throw err;
  }
}
