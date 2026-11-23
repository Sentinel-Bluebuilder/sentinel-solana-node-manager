import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppEvent, DeployedNode, DiscoveredNodeView, WalletState } from '../../shared/types';
import { log } from './logger';

// NM032: 0.3.0 reported store problems on stderr only, so a user's app.log showed nothing
// when his whole node list was lost. Every store problem now lands in app.log as well.
function storeProblem(message: string, err?: unknown): void {
  const detail = err === undefined ? '' : `: ${(err as Error)?.message ?? String(err)}`;
  process.stderr.write(`${message}${detail}\n`);
  try {
    log.warn(message, err === undefined ? undefined : { err: (err as Error)?.message ?? String(err) });
  } catch (logErr) {
    process.stderr.write(`store: could not write app.log: ${(logErr as Error).message}\n`);
  }
}

/**
 * Minimal on-disk JSON store.
 *
 * Secrets policy:
 *   - App wallet mnemonic lives at userData/wallet.secret, encrypted by
 *     Electron safeStorage (OS keychain).
 *   - Per-node operator mnemonics live on the node itself (in its own
 *     keyring). If the user opts to back one up in the app, it ends up in
 *     store.nodeBackups, also encrypted by safeStorage.
 *   - SSH credentials are persisted only when the user ticks "Remember logins" (0.3.2),
 *     and then only as safeStorage blobs in store.sshVault (see ssh-vault.ts).
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
  /** NM032: server logins the user chose to remember, `host:port` → safeStorage blob (ssh-vault.ts). */
  sshVault?: Record<string, string>;
  /** NM032: nodes this wallet funded that the list does not hold (recovery.ts), shown view-only. */
  discoveredNodes?: DiscoveredNode[];
}

/** A node found from the wallet's own funding transactions, not (yet) managed by this app. */
export type DiscoveredNode = DiscoveredNodeView;

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
    log.info('store loaded', { nodes: cached.nodes.length, wallet: cached.wallet ? 'set' : 'none', events: cached.events.length });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // A missing file is normal on first run; a missing file beside a backup is not.
      const bakExists = await fs.stat(backupPath()).then(() => true, () => false);
      if (bakExists) {
        try {
          cached = await loadStoreFile(backupPath());
          storeProblem(`store.json missing; restored ${cached.nodes.length} node(s) from store.json.bak`);
          return cached;
        } catch (bakErr) {
          storeProblem('store.json missing and store.json.bak unusable; starting empty', bakErr);
        }
      } else {
        log.info('store.json not found; starting with an empty store (first run)');
      }
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
      (e: unknown) => (storeProblem('could not keep the damaged store.json aside', e), false),
    );
    let restored = false;
    try {
      cached = await loadStoreFile(backupPath());
      restored = true;
    } catch (bakErr) {
      storeProblem('store.json backup unusable', bakErr);
      cached = structuredClone(DEFAULT_STORE);
    }
    storeProblem(`store.json unreadable; ${restored ? `restored ${cached.nodes.length} node(s) from the backup` : 'starting empty'}`, err);
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
    sshVault: parsed.sshVault ?? {},
    discoveredNodes: parsed.discoveredNodes ?? [],
  };
}

function backupPath(): string {
  return `${storePath()}.bak`;
}

// Backup (Q0596): after a save, the SAVED state is also written to store.json.bak, durably, as a
// second copy. It is refreshed at once when something that matters changes (a node added or
// removed, a key backup, prices, protocol, removal progress, the wallet, a saved login) and at
// most every 5 minutes otherwise: status polls save often. It used to copy the previous file only
// every 5 minutes, so a restore could bring back prices from before a change, or miss a node
// deployed minutes earlier together with its key.
// One guard: a save with no nodes never replaces a backup that still has some (the reporter's
// list was lost to an empty list saved over the good one).
const BACKUP_EVERY_MS = 5 * 60_000;
let lastBackupAt = 0;
let lastBackupSig = '';

/** What a backup must never lag behind. Volatile status (online, stats, timestamps) is left out. */
export function backupSignature(s: StoreShape): string {
  return JSON.stringify([
    s.wallet?.address ?? null,
    s.nodes.map((n) => [n.id, n.operatorAddress, n.nodePda, n.gigabytePriceDVPN, n.hourlyPriceDVPN, n.serviceType, n.removalStage ?? null]),
    Object.keys(s.nodeBackups ?? {}).sort(),
    Object.keys(s.sshVault ?? {}).sort(),
  ]);
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
    storeProblem('store.json write failed', err);
  });
  return run;
}

// NM032: the rename alone is only atomic for the directory entry. Without a flush, a power cut
// or forced restart right after it can leave store.json pointing at blocks never written (an
// empty or zero-filled file), which 0.3.0 then read as "no nodes". Flush the data first.
async function writeDurable(file: string, data: string): Promise<void> {
  const fh = await fs.open(file, 'w', 0o600);
  try {
    await fh.writeFile(data, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// Flush the directory entry after the rename where the OS allows it (POSIX). Windows cannot
// open a directory for flushing; NTFS journals the rename itself, so that case is expected.
async function syncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    fh = await fs.open(dir, 'r');
    await fh.sync();
  } catch (err) {
    log.debug('store dir flush skipped', { err: (err as Error).message });
  } finally {
    await fh?.close().catch((e: unknown) => log.debug('store dir handle close failed', { err: (e as Error).message }));
  }
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
  try {
    await writeDurable(tmp, JSON.stringify(next, null, 2));
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch((rmErr: unknown) => storeProblem(`store temp cleanup failed (${tmp})`, rmErr));
    throw err;
  }
  try {
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch((rmErr: unknown) => storeProblem(`store temp cleanup failed (${tmp})`, rmErr));
    throw err;
  }
  await syncDir(dir);
  const sig = backupSignature(next);
  if (sig !== lastBackupSig || Date.now() - lastBackupAt >= BACKUP_EVERY_MS) {
    if (await writeBackup(next)) {
      lastBackupSig = sig;
      lastBackupAt = Date.now();
    }
  }
}

// The backup is written from the state just saved (valid by construction), never by copying the
// file on disk, so a store.json damaged since the last save can never reach the backup.
/** Write the saved state to store.json.bak (durable, via a temp file). False when skipped or failed. */
async function writeBackup(next: StoreShape): Promise<boolean> {
  if (next.nodes.length === 0) {
    let bakNodes = 0;
    try {
      bakNodes = ((JSON.parse(await fs.readFile(backupPath(), 'utf8')) as { nodes?: unknown[] }).nodes ?? []).length;
    } catch (err) {
      log.debug('store backup: no readable backup to compare with', { err: (err as Error).message });
    }
    if (bakNodes > 0) {
      log.info('store backup kept: this save has no nodes, the backup has some', { backupNodes: bakNodes });
      return false;
    }
  }
  const bakTmp = `${backupPath()}.${process.pid}.${writeSeq}.tmp`;
  try {
    await writeDurable(bakTmp, JSON.stringify(next, null, 2));
    await fs.rename(bakTmp, backupPath());
    return true;
  } catch (err) {
    storeProblem('store.json backup failed', err);
    await fs.rm(bakTmp, { force: true }).catch((rmErr: unknown) => storeProblem(`store backup temp cleanup failed (${bakTmp})`, rmErr));
    return false;
  }
}
