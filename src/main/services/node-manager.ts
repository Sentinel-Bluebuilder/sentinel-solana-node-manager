import { BrowserWindow, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, createCloseAccountInstruction } from '@solana/spl-token';
import {
  CTL_HOME,
  chainCtlImageTag,
  isRunning,
  containerName,
  removeContainer as removeLocalContainer,
  localCtlImageTag,
  withDockerTimeout,
} from './docker';
import { readStore, writeStore } from './store';
import {
  READ_CTL_HOME_ID,
  chainCtlPlace,
  chainWaitTimeoutMessage,
  keyedSerial,
  keyedExclusive,
  statusWhileRemoving,
  remoteFallbackError,
  firstRemovalStage,
  hostCleanupMustBeRetried,
  isReservedRuntimeHome,
  leftoverVerdict,
  shouldRetryHostCleanup,
  forgetServerBlocker,
  withdrawBondBlocker,
  portsHeldByOthers,
  chainHelperCandidates,
  noChainHostMessage,
  isDockerUnavailable,
  isOlderPrebuiltTag,
  nodeBusyMessage,
} from './validate';
import { PREBUILT_IMAGE_TAG } from './prebuilt-image';
import { addEvent } from './events';
import { recordSample, purgeNode, history } from './metrics';
import {
  NODE_BOND_BASE,
  PORT_BLOCK_SIZE,
  baseToDisplay,
  displayToBase,
  explorerTx,
  protocolInfo,
} from './chain';
import { fetchBalances, sendFrom, signerFromMnemonic, tokenAccount, appKeypair, transferInstructions, refreshWalletBalance } from './wallet';
import { keypairToJson } from './keys';
import { sendTx, connection, withRetry, withRpcTimeout, pickRPC, RPC_QUERY_TIMEOUT_MS } from './solana-client';
import { getSettings } from './settings';
import { openRuntime, localNodeDir, type NodeRuntime } from './node-runtime';
import { isChainAddress, resolveNodeRef } from './node-ref';
import { blockPorts, getKey, patchNodeConfig } from './node-config';
import { homePathsFor } from './cli-layout';
import { cliLayoutOf } from './cli-probe';
import {
  closeNode,
  ctl,
  ctlVersion,
  daemonCloseSession,
  daemonInfo,
  daemonPositions,
  daemonRedemptions,
  daemonSession,
  inspectNode,
  ctlConfigToml,
  daemonRedeem,
  daemonSessions,
  delistNode,
  listNode,
  logCtlFailure,
  nodeUnbondingPda,
  programParams,
  programStatus,
  searchLeases,
  showNode,
  showUnbonding,
  withdrawNodeBond,
  withdrawNodeRevenue,
  type ChainLease,
  type ChainNode,
  type ProgramParams,
} from './dvpnctl';
import { log } from './logger';
import { hnsdNotRunningMessage, hnsProbe, hnsSyncState, waitForHnsd } from './hnsd';
import { removePath } from './local-privileged';
import {
  IPC,
  type DeployedNode,
  type NodeDeployTarget,
  type MetricsSample,
  type MetricsWindow,
  type NodeLiveStatus,
  type NodePlanLink,
  type NodeSession,
  type NodeStatus,
  type RemovalStage,
  type SSHCredentials,
  type VpnServiceType,
} from '../../shared/types';

/**
 * Node lifecycle + monitoring on the Solana program.
 *
 *   Host operations (start/stop/restart/logs/config edits) go through the
 *   node's runtime — this machine's Docker, or SSH for remote nodes.
 *
 *   Chain operations (show, list/delist, close, withdraw revenue/bond) go
 *   through `chainRuntime()`: dvpnctl in a one-shot container on THIS machine,
 *   signing with the node key decrypted from the app's backup. They therefore
 *   work for remote nodes without an SSH session.
 *
 *   Removal is a persisted stage machine (DeployedNode.removalStage) so an
 *   interrupted removal resumes on the next start, and the poller completes
 *   it once the unbonding period has passed.
 */

const sshKeyring = new Map<string, SSHCredentials>();
const startedAt = new Map<string, number>();
let poller: NodeJS.Timeout | null = null;

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
}

// ─── Inventory ───

export function nodeDataDir(nodeId: string): string {
  return localNodeDir(nodeId);
}

export async function listNodes(): Promise<DeployedNode[]> {
  return (await readStore()).nodes;
}

export async function getNode(id: string): Promise<DeployedNode | null> {
  return (await readStore()).nodes.find((n) => n.id === id) ?? null;
}

async function mustGet(id: string): Promise<DeployedNode> {
  const n = await getNode(id);
  if (!n) throw new Error(`Node ${id} not found.`);
  return n;
}

export function rememberSSH(nodeId: string, creds: SSHCredentials): void {
  sshKeyring.set(nodeId, creds);
}

export function getSSH(nodeId: string): SSHCredentials | undefined {
  return sshKeyring.get(nodeId);
}

export async function ensureNodePersisted(node: DeployedNode): Promise<void> {
  const store = await readStore();
  const idx = store.nodes.findIndex((n) => n.id === node.id);
  if (idx === -1) store.nodes.push(node);
  else store.nodes[idx] = { ...store.nodes[idx], ...node };
  await writeStore(store);
  broadcast(IPC.NODES_CHANGED, null);
}

export async function updateNode(id: string, patch: Partial<DeployedNode>): Promise<void> {
  const store = await readStore();
  const n = store.nodes.find((x) => x.id === id);
  if (!n) return;
  Object.assign(n, patch);
  await writeStore(store);
  broadcast(IPC.NODES_CHANGED, null);
}

export async function transition(id: string, status: NodeStatus): Promise<void> {
  // A poll that read the node before its removal began must not mark it online again (Q0328).
  const node = await getNode(id);
  await updateNode(id, { status: statusWhileRemoving(node?.removalStage, status) });
}

// ─── Keys ───

/** The node's key (its on-chain owner), from the encrypted phrase backup. */
export async function nodeKeypair(nodeId: string): Promise<Keypair> {
  const store = await readStore();
  const blob = store.nodeBackups[nodeId];
  if (!blob) throw new Error('This node has no key backup in the app, so it cannot sign. Restore it from its recovery phrase first.');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('The OS keychain is unavailable; the node key backup cannot be decrypted.');
  const mnemonic = safeStorage.decryptString(Buffer.from(blob, 'base64'));
  return signerFromMnemonic(mnemonic);
}

/**
 * The runtime a node's chain commands run in (see chainCtlPlace): a remote node's own
 * host when it answers and holds the node image (it already has the key), else this
 * computer's Docker with home = userData/nodes/<id> (for a local node that IS its home).
 */
const noCredsLogged = new Set<string>();
async function openChainCtl(node: DeployedNode): Promise<NodeRuntime> {
  let remoteWhy = '';
  if (node.target === 'remote') {
    const creds = getSSH(node.id);
    let remoteImage: 'ready' | 'missing' | 'unreachable' = 'unreachable';
    let remote: NodeRuntime | undefined;
    if (!creds) {
      // SSH credentials live in memory only, so every app restart lands here (FLX2, Q0409).
      remoteWhy = 'the app has no SSH connection to it (it is lost at every app restart)';
      // Once per node per app run: the poller lands here every minute until Reconnect (T4 log hygiene).
      if (!noCredsLogged.has(node.id)) {
        noCredsLogged.add(node.id);
        log.warn('no SSH credentials for the node host; chain commands run on this computer until Reconnect', { id: node.id, host: node.host });
      }
    } else {
      noCredsLogged.delete(node.id);
      try {
        remote = await openRuntime(node, creds);
        remoteImage = (await remote.imageReady()) ? 'ready' : 'missing';
      } catch (err) {
        remoteWhy = `it did not answer (${(err as Error).message.slice(0, 160)})`;
        log.warn('node host unreachable for chain commands; using this computer', { id: node.id, err: (err as Error).message });
      }
    }
    if (remote && chainCtlPlace({ target: 'remote', hasCreds: Boolean(creds), remoteImage }) === 'node-host') return remote;
    if (remote) {
      log.info('node host lacks its image; chain commands run on this computer', { id: node.id, imageTag: node.imageTag });
      await remote.close().catch((err: unknown) => log.warn('remote runtime close failed', { id: node.id, err: (err as Error).message }));
    }
  }
  // The node's own image when this machine has it; else the current source's image
  // (built here once) — see localCtlImageTag.
  try {
    const imageTag = await localCtlImageTag(node.imageTag);
    return await openRuntime({ id: node.id, target: 'local', runtimeId: undefined, host: undefined, imageTag });
  } catch (err) {
    // Fix A (0.3.1): this computer cannot run it (Docker off, missing, or no image). Any other
    // server the app holds SSH credentials for can sign instead: the node key is written into a
    // per-node ctl home there for the one call and removed after (runChainCtl).
    const helper = await openChainHelper(node);
    if (helper) return helper;
    if (remoteWhy) {
      if (!getSSH(node.id)) log.info('chain command waits for Reconnect; this computer could not run it', { id: node.id, err: (err as Error).message });
      throw new Error(remoteFallbackError(node.host ?? 'its server', remoteWhy, (err as Error).message, !getSSH(node.id)));
    }
    throw new Error(noChainHostMessage((err as Error).message));
  }
}

// ─── Chain-call server (fix A) ───

/** SSH credentials of the server the user named for chain calls. Memory only, like all SSH creds. */
let chainHostCreds: SSHCredentials | undefined;
/** Runtimes opened on a helper server (not the node's own host): their ctl home is removed after use. */
const helperRuntimes = new WeakSet<NodeRuntime>();

export function setChainHost(creds: SSHCredentials | undefined): void {
  chainHostCreds = creds;
}

/**
 * Use `creds` as the chain-call server (null forgets it). The server is proven first (SSH,
 * Docker, prebuilt image); then every parked removal is nudged so it finishes right away.
 */
export async function useChainHost(creds: SSHCredentials | null): Promise<{ ok: boolean; error?: string; label: string | null }> {
  if (!creds) {
    setChainHost(undefined);
    log.info('chain-call server forgotten');
    return { ok: true, label: null };
  }
  const t = await testChainHost(creds);
  if (!t.ok) return { ok: false, error: t.error, label: chainHostLabel() };
  setChainHost(creds);
  log.info('chain-call server set', { server: chainHostLabel() });
  for (const n of await listNodes()) {
    if (n.removalStage) void advanceRemoval(n.id, { force: true }).catch((err: unknown) => log.warn('resume removal after chain-call server set failed', { id: n.id, err: (err as Error).message }));
  }
  return { ok: true, label: chainHostLabel() };
}

export function chainHostLabel(): string | null {
  return chainHostCreds ? `${chainHostCreds.username}@${chainHostCreds.host}:${chainHostCreds.port}` : null;
}

/** Check a chain-call server answers, has Docker and holds (or can download) the prebuilt image. */
export async function testChainHost(creds: SSHCredentials): Promise<{ ok: boolean; error?: string }> {
  try {
    const rt = await openRuntime({ id: READ_CTL_HOME_ID, target: 'remote', host: creds.host, runtimeId: undefined, imageTag: PREBUILT_IMAGE_TAG }, creds);
    try {
      if (!(await rt.imageReady())) await rt.buildImage((l) => log.debug('chain host image', { line: l }));
      return { ok: true };
    } finally {
      await rt.close();
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * A ctl runtime for wallet-level chain calls (test channels): this computer's Docker, else a
 * helper server (fix A). The caller removes its home and closes it, as before.
 */
export async function openWalletCtl(id: string, imageTag?: string): Promise<NodeRuntime> {
  try {
    return await openRuntime({ id, target: 'local', runtimeId: undefined, host: undefined, imageTag: await localCtlImageTag(imageTag) });
  } catch (err) {
    const helper = await openChainHelper({ id, target: 'local' } as DeployedNode);
    if (helper) return helper;
    throw new Error(noChainHostMessage((err as Error).message));
  }
}

async function openChainHelper(node: DeployedNode): Promise<NodeRuntime | null> {
  const byKey = new Map<string, SSHCredentials>();
  const key = (c: { host: string; port: number; username: string }) => `${c.host}:${c.port}:${c.username}`;
  if (chainHostCreds) byKey.set(key(chainHostCreds), chainHostCreds);
  for (const [id, c] of sshKeyring) if (id !== node.id && !byKey.has(key(c))) byKey.set(key(c), c);
  const order = chainHelperCandidates({
    nodeHost: node.target === 'remote' ? node.host : undefined,
    chainHost: chainHostCreds,
    connected: [...sshKeyring.entries()].filter(([id]) => id !== node.id).map(([, c]) => c),
  });
  for (const cand of order) {
    const creds = byKey.get(key(cand));
    if (!creds) continue;
    try {
      // Prebuilt image only: a helper never builds from source (that uploads the whole tree).
      const rt = await openRuntime({ id: node.id, target: 'remote', host: creds.host, runtimeId: undefined, imageTag: PREBUILT_IMAGE_TAG }, creds);
      try {
        if (!(await rt.imageReady())) await rt.buildImage((l) => log.debug('chain helper image', { line: l }));
      } catch (err) {
        await rt.close().catch((e: unknown) => log.warn('helper runtime close failed', { err: (e as Error).message }));
        throw err;
      }
      // The same server can hide behind another name (a DNS name vs the node's IP). If this node's
      // home already exists there it IS the node's home: sign there, but never remove it after.
      const preexisting = (await rt.listHomes()).includes(node.id);
      if (!preexisting) helperRuntimes.add(rt);
      log.info('chain commands run on another server (this computer cannot)', { id: node.id, server: cand.host, source: cand.source, nodeHomeThere: preexisting });
      return rt;
    } catch (err) {
      log.warn('chain helper server unusable', { id: node.id, server: cand.host, err: (err as Error).message });
    }
  }
  return null;
}

/**
 * One chain call per node at a time: they share the node's ctl home and its key file (Q0410).
 * A callback must never call withChainCtl for the same node (it would wait on itself).
 */
const chainCtlQueue = keyedSerial();
// T7: one config change (price, protocol, HNS, restart) per node at a time; the second is refused.
const configChange = keyedExclusive();
export const configChangeRunning = (id: string): string | undefined => configChange.current(id);

/**
 * A runtime for a node's chain operations (openChainCtl). The dvpnctl home is
 * (re)written with the node key and current RPC before use.
 */
function withChainCtl<T>(node: DeployedNode, fn: (rt: NodeRuntime) => Promise<T>): Promise<T> {
  return chainCtlQueue(node.id, () => runChainCtl(node, fn));
}

async function runChainCtl<T>(node: DeployedNode, fn: (rt: NodeRuntime) => Promise<T>): Promise<T> {
  const rt = await openChainCtl(node);
  try {
    await rt.prepare();
    const kp = await nodeKeypair(node.id);
    await rt.writeFile('ctl/keys/owner.json', keypairToJson(kp), 0o600);
    await rt.writeFile('ctl/config.toml', ctlConfigToml(await pickRPC({ forRemoteHost: rt.kind === 'remote' })), 0o600);
    return await fn(rt);
  } finally {
    // The plaintext key copy exists only for the duration of the call. For a
    // local node the daemon has its own copy under node/keys/.
    const helper = helperRuntimes.has(rt);
    await rt.removeFile('ctl/keys/owner.json').then(async () => {
      if (helper) await clearNodeError(node.id, 'Key cleanup on helper server');
    }, async (err: unknown) => {
      log.warn('ctl key cleanup failed', { id: node.id, err: (err as Error).message });
      // A node key left on someone else's server must be visible, not only logged (fix F).
      if (helper) await noteNodeError(node.id, 'Key cleanup on helper server', `${(err as Error).message}. Delete ctl/keys/owner.json under the node's folder on that server.`);
    });
    // On a helper server the whole per-node home was made for this call: leave nothing behind.
    if (helper) {
      await rt.removeHome().catch((err: unknown) => log.warn('helper ctl home cleanup failed', { id: node.id, err: (err as Error).message }));
    }
    await rt.close();
  }
}

// ─── Deploy ↔ removal coordination ───
// deploy.ts marks a node while its job runs; removal / reaping must not touch
// the key underneath an in-flight open_node.
const deploying = new Set<string>();
export function markDeploying(nodeId: string, on: boolean): void {
  if (on) deploying.add(nodeId);
  else deploying.delete(nodeId);
}
export function isDeploying(nodeId: string): boolean {
  return deploying.has(nodeId);
}

/** Lamports below which a node key cannot pay for its next signed instruction. */
const NODE_GAS_FLOOR_LAMPORTS = 2_000_000; // 0.002 SOL
const NODE_GAS_TOPUP_SOL = 0.005;

/**
 * Every node-signed instruction (delist, close, withdraw, sweep) pays its fee
 * from the SOL seeded at deploy. Top it up from the app wallet when it runs low
 * so a removal can never stall on an empty key; the final sweep returns it.
 */
async function ensureNodeKeyGas(node: DeployedNode): Promise<void> {
  const bal = await fetchBalances(node.operatorAddress);
  if (bal.lamports >= NODE_GAS_FLOOR_LAMPORTS) return;
  const app = await appKeypair();
  const r = await sendFrom(app, node.operatorAddress, 0, NODE_GAS_TOPUP_SOL, `gas top-up ${node.moniker}`.slice(0, 60), {
    title: `Fee top-up for ${node.moniker}`,
    subtitle: `${NODE_GAS_TOPUP_SOL} SOL to the node key (returned at removal)`,
    amountDVPN: 0,
    relatedNodeId: node.id,
  });
  log.info('node key topped up for fees', { id: node.id, lamportsBefore: bal.lamports, sig: r.txHash });
}

/** True when the key holds nothing worth sweeping (rent dust aside). */
async function keyIsEmpty(address: string): Promise<boolean> {
  const bal = await fetchBalances(address);
  return bal.dvpnBase === 0n && !bal.hasTokenAccount && bal.lamports <= 10_000;
}

/** Host runtime (container + files) for a node. */
async function withHost<T>(node: DeployedNode, fn: (rt: NodeRuntime) => Promise<T>): Promise<T> {
  const rt = await openRuntime(node, getSSH(node.id));
  try {
    return await fn(rt);
  } finally {
    await rt.close();
  }
}

/**
 * Does the node account exist on chain? A plain RPC read: no Docker, no image, so it
 * answers for a remote node too. 'unknown' only when no RPC answered.
 */
export async function nodeAccountState(nodePdaAddr: string): Promise<'exists' | 'missing' | 'unknown'> {
  try {
    const conn = await connection();
    const info = await withRetry(
      () => withRpcTimeout(() => conn.getAccountInfo(new PublicKey(nodePdaAddr), 'confirmed'), RPC_QUERY_TIMEOUT_MS, 'getAccountInfo(node)'),
      'getAccountInfo(node)',
    );
    return info ? 'exists' : 'missing';
  } catch (err) {
    log.warn('node account read failed', { nodePda: nodePdaAddr, err: (err as Error).message });
    return 'unknown';
  }
}

/** Read the node's on-chain account (null when closed / not opened). */
export async function chainNode(node: DeployedNode): Promise<ChainNode | null> {
  if (!node.nodePda) return null;
  return withChainCtl(node, (rt) => showNode(rt, node.nodePda!));
}

// ─── Nodes this app did not deploy (Q0169 / NM11) ───

/** Runtime id for chain reads that belong to no node record. */
const READ_CTL_ID = READ_CTL_HOME_ID;

/**
 * A local dvpnctl for reads of any account. It signs nothing, so it holds a
 * throwaway key, never the app wallet or a node key.
 */
async function withReadCtl<T>(fn: (rt: NodeRuntime) => Promise<T>): Promise<T> {
  const imageTag = await chainCtlImageTag();
  const rt = await openRuntime({ id: READ_CTL_ID, target: 'local', runtimeId: undefined, host: undefined, imageTag });
  try {
    await rt.prepare();
    await rt.writeFile('ctl/keys/owner.json', keypairToJson(Keypair.generate()), 0o600);
    await rt.writeFile('ctl/config.toml', ctlConfigToml(await pickRPC()), 0o600);
    return await fn(rt);
  } finally {
    await rt.removeFile('ctl/keys/owner.json').catch((err: unknown) => log.warn('read ctl key cleanup failed', { err: (err as Error).message }));
    await rt.close();
  }
}

/** On-chain account of a node named by this app's id or by its chain address. */
export async function chainNodeByRef(ref: string): Promise<ChainNode | null> {
  const r = resolveNodeRef(ref, await listNodes());
  if (r.kind === 'managed') return chainNode(r.node);
  return withReadCtl((rt) => showNode(rt, r.address));
}

/** Leases on a node named by this app's id or by its chain address. */
export async function nodeLeasesByRef(ref: string): Promise<NodePlanLink[]> {
  const r = resolveNodeRef(ref, await listNodes());
  if (r.kind === 'managed') return nodeLeases(r.node.id);
  return (await withReadCtl((rt) => searchLeases(rt, r.address))).map(leaseLink);
}

export interface WatchedNode {
  address: string;
  label?: string;
  addedAt: string;
  /** The account now; null when it is closed or the read failed (see error). */
  chain: ChainNode | null;
  error?: string;
}

/**
 * Follow a node this app did not deploy, read-only. The address must hold a
 * node account now, so a typo is refused instead of watched forever.
 */
export async function watchNode(address: string, label?: string): Promise<WatchedNode> {
  if (!isChainAddress(address)) throw new Error('Invalid node address: expected an on-chain node address (base58)');
  const store = await readStore();
  if (store.nodes.some((n) => n.nodePda === address)) throw new Error('This node is already managed by the app; it is in nodes.list.');
  const chain = await withReadCtl((rt) => showNode(rt, address));
  if (!chain) throw new Error(`No node account at ${address} on this network.`);
  const watched = store.watchedNodes ?? [];
  const existing = watched.find((w) => w.address === address);
  const entry = existing ?? { address, label: label?.slice(0, 64), addedAt: new Date().toISOString() };
  if (!existing) await writeStore({ ...store, watchedNodes: [...watched, entry] });
  return { ...entry, chain };
}

export async function unwatchNode(address: string): Promise<{ removed: boolean }> {
  const store = await readStore();
  const watched = store.watchedNodes ?? [];
  const next = watched.filter((w) => w.address !== address);
  if (next.length !== watched.length) await writeStore({ ...store, watchedNodes: next });
  return { removed: next.length !== watched.length };
}

/** Watched nodes with their current chain state, read one at a time. */
export async function watchedNodes(): Promise<WatchedNode[]> {
  const watched = (await readStore()).watchedNodes ?? [];
  if (watched.length === 0) return [];
  return withReadCtl(async (rt) => {
    const out: WatchedNode[] = [];
    for (const w of watched) {
      try {
        out.push({ ...w, chain: await showNode(rt, w.address) });
      } catch (err) {
        log.warn('reading watched node failed', { address: w.address, err: (err as Error).message });
        out.push({ ...w, chain: null, error: (err as Error).message });
      }
    }
    return out;
  });
}

/**
 * Program parameters, cached for 10 minutes: they change only by governance,
 * and every read is a container run. `rt` must already have a dvpnctl config.
 */
let paramsCache: { at: number; value: ProgramParams } | null = null;
const PARAMS_TTL_MS = 10 * 60_000;
let paramsInFlight: Promise<ProgramParams> | null = null;
async function cachedParams(rt: NodeRuntime): Promise<ProgramParams> {
  if (paramsCache && Date.now() - paramsCache.at < PARAMS_TTL_MS) return paramsCache.value;
  if (!paramsInFlight) {
    paramsInFlight = programParams(rt)
      .then((value) => {
        paramsCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        paramsInFlight = null;
      });
  }
  return paramsInFlight;
}
/** Last known parameters without a chain read (null before the first read). */
function knownParams(): ProgramParams | null {
  return paramsCache?.value ?? null;
}

// ─── Container lifecycle ───

export function nodePorts(node: DeployedNode): number[] {
  const b = blockPorts(node.port, PORT_BLOCK_SIZE);
  return [b.api, ...b.service];
}

/**
 * The ports to close at `node`'s removal. A ufw rule covers the whole block as one range, so
 * when another node on this host still holds any of these ports the rule stays: [] is returned.
 */
export async function portsToClose(node: DeployedNode, ports: number[]): Promise<number[]> {
  const held = portsHeldByOthers(node, await listNodes(), nodePorts);
  const shared = ports.filter((p) => held.has(p));
  if (!shared.length) return ports;
  log.info('firewall rule kept: another node on this host uses these ports', { node: node.id, ports: shared });
  return [];
}

export async function startNode(id: string): Promise<void> {
  const node = await mustGet(id);
  if (node.removalStage) throw new Error('This node is being removed; it cannot be started.');
  await withHost(node, async (rt) => {
    const runtimeId = await rt.startContainer(nodePorts(node));
    const now = new Date().toISOString();
    startedAt.set(id, Date.now());
    await updateNode(id, { runtimeId, startedAt: now, status: 'loading' });
  });
  await addEvent({ kind: 'node-started', title: `Node ${node.moniker} started`, subtitle: node.region ?? '', relatedNodeId: id });
}

export async function stopNode(id: string): Promise<void> {
  const node = await mustGet(id);
  if (node.removalStage) throw new Error('This node is being removed; the removal stops it.');
  await withHost(node, (rt) => rt.stopContainer()); // throws unless stopped or already gone
  await transition(id, 'offline');
  await addEvent({
    kind: 'node-stopped',
    title: `Node ${node.moniker} stopped`,
    subtitle: 'Still listed until its 24 h listing expires — remove it to delist now',
    relatedNodeId: id,
  });
}

export async function restartNode(id: string): Promise<void> {
  return configChange.run(id, 'A restart', () => restartNodeNow(id));
}

async function restartNodeNow(id: string): Promise<void> {
  const node = await mustGet(id);
  if (node.removalStage) throw new Error('This node is being removed; it cannot be restarted.');
  // NM-C9-4: Restart is how an HNS node on an older image gets the current one (config unchanged).
  if (hnsImageOutdated(node)) {
    await patchAndRestart(node, (t) => t, { recreate: true });
    await addEvent({ kind: 'node-restarted', title: `Node ${node.moniker} restarted on node image ${PREBUILT_IMAGE_TAG.replace(/^.*prebuilt-/, '')}`, subtitle: 'HNS resolver fixes', relatedNodeId: id });
    return;
  }
  const runtimeId = await withHost(node, async (rt) => {
    if (await rt.isRunning()) {
      await rt.restartContainer();
      return node.runtimeId;
    }
    return rt.startContainer(nodePorts(node)); // a new container: its id must be persisted
  });
  startedAt.set(id, Date.now());
  await updateNode(id, { runtimeId, startedAt: new Date().toISOString(), status: 'loading' });
  await addEvent({ kind: 'node-restarted', title: `Node ${node.moniker} restarted`, subtitle: node.region ?? '', relatedNodeId: id });
}

export async function recentLogs(id: string): Promise<string[]> {
  const node = await mustGet(id);
  return withHost(node, (rt) => rt.logs(200));
}

// ─── Config-driven changes (prices, protocol): edit config, restart, chain follows ───

/**
 * NM-C9-4: an HNS node on an older prebuilt image (the 0.3.x images differ only in the HNS layer:
 * 0.3.7 fixes HNS names over Hysteria2, 0.3.6 the sync status and hnsd memory). Without this a
 * protocol switch or restart kept e.g. prebuilt-0.3.5, and HNS names failed over Hysteria2.
 */
export function hnsImageOutdated(node: Pick<DeployedNode, 'handshakeDns' | 'imageTag'>): boolean {
  return !!node.handshakeDns && isOlderPrebuiltTag(node.imageTag, PREBUILT_IMAGE_TAG);
}

async function patchAndRestart(node: DeployedNode, mutate: (toml: string) => string, opts: { recreate?: boolean } = {}): Promise<void> {
  if (node.removalStage) throw new Error('This node is being removed; its configuration can no longer change.');
  // Any config change (protocol, prices) of an HNS node on an older image moves it to the current one.
  if (hnsImageOutdated(node)) opts = { ...opts, recreate: true };
  const { runtimeId, imageTag } = await withHost(node, async (rt) => {
    let imageTag = node.imageTag;
    // Recreate (HNS toggle): an older prebuilt image moves to the current one (same daemon
    // binaries, plus the 0.3.1 DNS routing layer), and the container gets today's run options
    // (log cap). `docker restart` would keep both as they were.
    if (opts.recreate && isOlderPrebuiltTag(node.imageTag, PREBUILT_IMAGE_TAG)) {
      rt.imageTag = PREBUILT_IMAGE_TAG;
      if (!(await rt.imageReady())) await rt.buildImage((line) => log.debug('node image', { id: node.id, line }));
      imageTag = PREBUILT_IMAGE_TAG;
      log.info('node image updated for a config change', { id: node.id, from: node.imageTag, to: imageTag });
    }
    const { nodeConfig } = homePathsFor(await cliLayoutOf(rt));
    await rt.writeFile(nodeConfig, mutate(await rt.readFile(nodeConfig)), 0o600);
    if (!opts.recreate && (await rt.isRunning())) {
      await rt.restartContainer();
      return { runtimeId: node.runtimeId, imageTag };
    }
    return { runtimeId: await rt.startContainer(nodePorts(node)), imageTag };
  });
  startedAt.set(node.id, Date.now());
  await updateNode(node.id, { runtimeId, imageTag, startedAt: new Date().toISOString(), status: 'loading' });
}

/**
 * After a config change the daemon restarts and re-syncs the node on chain (re-list, prices,
 * protocol) one transaction at a time. On a small server (2 vCPU arm64, e2e 11-10) that took over
 * 180 s although it landed, so the app reported a failed change that had succeeded.
 */
const CHAIN_SYNC_WAIT_MS = 360_000;

/** Wait until the chain shows `pred` for this node (the daemon's start-up sync landed). */
async function waitForChain(node: DeployedNode, pred: (c: ChainNode) => boolean, what: string, timeoutMs = CHAIN_SYNC_WAIT_MS): Promise<ChainNode> {
  const deadline = Date.now() + timeoutMs;
  let last: ChainNode | null = null;
  let readError: string | undefined;
  while (Date.now() < deadline) {
    last = await chainNode(node).then(
      (c) => {
        readError = undefined;
        return c;
      },
      (err: unknown) => {
        readError = (err as Error).message;
        log.debug('waitForChain read failed', { err: readError });
        return null;
      },
    );
    if (last && pred(last)) return last;
    await new Promise((r) => setTimeout(r, 8_000));
  }
  throw new Error(chainWaitTimeoutMessage(what, timeoutMs, readError));
}

export async function updateNodePricing(
  id: string,
  gigabytePriceDVPN: number,
  hourlyPriceDVPN: number,
  opts: { leaseHourlyPriceDVPN?: number } = {},
): Promise<{ ok: boolean; error?: string }> {
  try {
    return await configChange.run(id, 'A price change', () => updateNodePricingNow(id, gigabytePriceDVPN, hourlyPriceDVPN, opts));
  } catch (err) {
    log.error('updateNodePricing failed', { id, err: (err as Error).message });
    return { ok: false, error: (err as Error).message };
  }
}

async function updateNodePricingNow(
  id: string,
  gigabytePriceDVPN: number,
  hourlyPriceDVPN: number,
  opts: { leaseHourlyPriceDVPN?: number },
): Promise<{ ok: boolean; error?: string }> {
  {
    const node = await mustGet(id);
    const prices = {
      perGb: Number(displayToBase(gigabytePriceDVPN)),
      perHour: Number(displayToBase(hourlyPriceDVPN)),
      leasePerHour: Number(displayToBase(opts.leaseHourlyPriceDVPN ?? node.leaseHourlyPriceDVPN ?? hourlyPriceDVPN)),
    };
    if (![prices.perGb, prices.perHour, prices.leasePerHour].every((p) => Number.isFinite(p) && p > 0)) throw new Error('All three prices must be numbers greater than 0.');
    await patchAndRestart(node, (t) => patchNodeConfig(t, { prices }));
    await waitForChain(
      node,
      (c) => c.prices.perGb === prices.perGb && c.prices.perHour === prices.perHour && c.prices.leasePerHour === prices.leasePerHour,
      'the new prices',
    );
    await updateNode(id, {
      gigabytePriceDVPN,
      hourlyPriceDVPN,
      leaseHourlyPriceDVPN: baseToDisplay(prices.leasePerHour),
    });
    await addEvent({
      kind: 'node-repriced',
      title: `Prices updated on ${node.moniker}`,
      subtitle: `${gigabytePriceDVPN} /GB · ${hourlyPriceDVPN} /h · lease ${baseToDisplay(prices.leasePerHour)} /h`,
      relatedNodeId: id,
    });
    return { ok: true };
  }
}

/** Switch the one protocol this node serves. Ports were pinned for all six at deploy. */
export async function setNodeProtocol(id: string, serviceType: VpnServiceType): Promise<{ ok: boolean; error?: string }> {
  try {
    return await configChange.run(id, 'A protocol switch', () => setNodeProtocolNow(id, serviceType));
  } catch (err) {
    log.error('setNodeProtocol failed', { id, err: (err as Error).message });
    return { ok: false, error: (err as Error).message };
  }
}

async function setNodeProtocolNow(id: string, serviceType: VpnServiceType): Promise<{ ok: boolean; error?: string }> {
  {
    const node = await mustGet(id);
    const bit = protocolInfo(serviceType).bit;
    await patchAndRestart(node, (t) => patchNodeConfig(t, { service: serviceType }));
    await waitForChain(node, (c) => c.protocols === bit, `protocol ${serviceType}`);
    await updateNode(id, { serviceType });
    await addEvent({ kind: 'node-protocol-changed', title: `${node.moniker} now serves ${serviceType}`, subtitle: `on-chain protocol bit ${bit}`, relatedNodeId: id });
    return { ok: true };
  }
}

/**
 * Turn the node's HNS resolver on or off: set `[handshake_dns] enabled`, restart the
 * daemon (it starts or stops hnsd itself), then check the hnsd process followed.
 */
export async function setNodeHandshakeDns(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  try {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false');
    return await configChange.run(id, 'An HNS resolver switch', () => setNodeHandshakeDnsNow(id, enabled));
  } catch (err) {
    log.error('setNodeHandshakeDns failed', { id, enabled, err: (err as Error).message });
    return { ok: false, error: (err as Error).message };
  }
}

async function setNodeHandshakeDnsNow(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  {
    const node = await mustGet(id);
    await patchAndRestart(node, (t) => patchNodeConfig(t, { handshakeDns: enabled }), { recreate: true });
    await updateNode(id, { handshakeDns: enabled, hnsdError: undefined });
    const followed = await withHost(node, (rt) => waitForHnsd(rt, enabled));
    if (!followed) {
      const why = enabled
        ? hnsdNotRunningMessage(await withHost(node, (rt) => rt.logs(200)))
        : 'The HNS resolver is off in the node config, but an hnsd process is still running in the node container.';
      await updateNode(id, { hnsdError: why });
      throw new Error(why);
    }
    log.info('HNS resolver switched', { id, enabled });
    await addEvent({
      kind: 'node-hns-changed',
      title: `${node.moniker}: HNS resolver ${enabled ? 'on' : 'off'}`,
      subtitle: enabled ? 'hnsd running in the node container' : 'hnsd stopped',
      relatedNodeId: id,
    });
    return { ok: true };
  }
}

// ─── Daemon actions ───

export async function redeemNow(id: string): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  try {
    const node = await mustGet(id);
    if (node.removalStage && node.removalStage !== 'redeem') throw new Error('This node is being removed; its final redeem already ran.');
    const result = await withHost(node, (rt) => daemonRedeem(rt));
    await addEvent({ kind: 'node-redeemed', title: `Redeemed vouchers on ${node.moniker}`, subtitle: JSON.stringify(result).slice(0, 160), relatedNodeId: id });
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function relistNow(id: string): Promise<{ ok: boolean; txHash?: string; error?: string }> {
  try {
    const node = await mustGet(id);
    if (!node.nodePda) throw new Error('This node is not on chain yet.');
    if (node.removalStage) throw new Error('This node is being removed; it cannot be re-listed.');
    // Always an explicit list_node: the daemon's heartbeat skips a still-fresh
    // listing, so it cannot be relied on to extend the listing on demand.
    await ensureNodeKeyGas(node);
    const sig = await withChainCtl(node, (rt) => listNode(rt, node.nodePda!));
    await addEvent({ kind: 'node-registered', title: `${node.moniker} re-listed`, subtitle: 'listing extended 24 h', relatedNodeId: id, txHash: sig });
    return { ok: true, txHash: sig };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── Withdraw revenue ───

/**
 * Move the node's on-chain revenue to its key's token account
 * (withdraw_node_revenue), then send it — plus any tDVPN already on the key —
 * to `to` (default: the app wallet).
 */
export async function withdrawFromNode(
  nodeId: string,
  to: string,
  amountDVPN?: number,
): Promise<{ ok: boolean; txHash?: string; error?: string }> {
  try {
    const node = await mustGet(nodeId);
    const kp = await nodeKeypair(nodeId);
    const dest = to?.trim() || (await appKeypair()).publicKey.toBase58();
    const chain = await chainNode(node);
    if (chain && chain.revenue > 0) {
      await ensureNodeKeyGas(node);
      const sig = await withChainCtl(node, async (rt) => {
        const params = await cachedParams(rt);
        return withdrawNodeRevenue(rt, {
          node: node.nodePda!,
          owner: node.operatorAddress,
          ownerToken: tokenAccount(node.operatorAddress).toBase58(),
          vault: params.vault,
          amountBase: chain.revenue,
        });
      });
      log.info('withdraw_node_revenue', { nodeId, sig, revenue: chain.revenue });
    }
    const bal = await fetchBalances(node.operatorAddress);
    const amount = amountDVPN !== undefined ? Math.min(amountDVPN, bal.dvpn) : bal.dvpn;
    if (!(amount > 0)) return { ok: false, error: 'Nothing to withdraw yet — the node has no revenue.' };
    const res = await sendFrom(kp, dest, amount, 0, `withdraw ${node.moniker}`.slice(0, 60), {
      title: `Revenue withdrawn from ${node.moniker}`,
      subtitle: `to ${dest.slice(0, 6)}…${dest.slice(-6)}`,
      amountDVPN: amount, // incoming to the app wallet
      relatedNodeId: nodeId,
    });
    await refreshNodeBalances(node);
    return { ok: res.ok, txHash: res.txHash, error: res.error };
  } catch (err) {
    log.error('withdrawFromNode failed', { nodeId, err: (err as Error).message });
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Send everything on the node key back to the app wallet: all tDVPN, close
 * the (empty) token account to reclaim its rent, then all SOL minus the fee.
 */
export async function sweepNodeKey(nodeId: string): Promise<string | undefined> {
  const node = await mustGet(nodeId);
  const kp = await nodeKeypair(nodeId);
  const wallet = (await appKeypair()).publicKey;
  const bal = await fetchBalances(node.operatorAddress);
  const ixs = [];
  if (bal.dvpnBase > 0n) ixs.push(...transferInstructions(kp.publicKey, wallet, bal.dvpnBase, 0));
  if (bal.hasTokenAccount) {
    ixs.push(createCloseAccountInstruction(tokenAccount(kp.publicKey), wallet, kp.publicKey, [], TOKEN_2022_PROGRAM_ID));
  }
  if (ixs.length) await sendTx(ixs, kp, [], 'sweep tokens');
  const conn = await connection();
  const lamports = await withRetry(() => conn.getBalance(kp.publicKey, 'confirmed'), 'getBalance');
  // Ask the cluster what THIS transaction costs (base fee + any priority fee
  // sendTx will prepend); a fixed 5000 would under-pay with a priority fee set
  // and leave the removal stuck at 'sweep' forever.
  const fee = await sweepFeeLamports(conn, kp.publicKey, wallet);
  let sig: string | undefined;
  if (lamports > fee) {
    const r = await sendTx(
      [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: wallet, lamports: lamports - fee })],
      kp,
      [],
      'sweep SOL',
    );
    sig = r.signature;
  }
  await addEvent({
    kind: 'funds-swept',
    title: `Swept ${node.moniker}'s key back to the wallet`,
    subtitle: `${bal.dvpn} tDVPN · ${(lamports / 1e9).toFixed(4)} SOL`,
    relatedNodeId: nodeId,
    txHash: sig,
  });
  // NM-C9 (c): the header kept the old balance until clicked after a background sweep.
  await refreshWalletBalance();
  return sig;
}

/** Fee of the SOL sweep as sendTx will build it (priority-fee instruction included). */
async function sweepFeeLamports(conn: Awaited<ReturnType<typeof connection>>, from: PublicKey, to: PublicKey): Promise<number> {
  const BASE_FEE = 5_000;
  try {
    const { priorityFeeMicroLamports } = await getSettings();
    const ixs = [SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: 1 })];
    if (priorityFeeMicroLamports > 0) ixs.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }));
    const { blockhash } = await withRetry(() => conn.getLatestBlockhash('confirmed'), 'getLatestBlockhash');
    const msg = new Transaction({ feePayer: from, blockhash, lastValidBlockHeight: 0 }).add(...ixs).compileMessage();
    const fee = await withRetry(() => conn.getFeeForMessage(msg, 'confirmed'), 'getFeeForMessage');
    return Math.max(BASE_FEE, fee.value ?? BASE_FEE);
  } catch (err) {
    log.warn('fee estimate failed; using the base fee', { err: (err as Error).message });
    return BASE_FEE;
  }
}

async function refreshNodeBalances(node: DeployedNode): Promise<void> {
  try {
    const b = await fetchBalances(node.operatorAddress);
    await updateNode(node.id, { balanceDVPN: b.dvpn, balanceSOL: b.sol });
  } catch (err) {
    log.debug('node balance refresh failed', { id: node.id, err: (err as Error).message });
  }
}

// ─── Removal (resumable) ───

const removalsInFlight = new Set<string>();

/**
 * How long to wait before re-attempting a remote host cleanup that already failed.
 * Chain and funds are settled by then; only the box still holds leftovers, and the
 * usual cause (SSH credentials lost on restart) cannot clear without a Reconnect —
 * which calls advanceRemoval directly and bypasses this delay.
 */
const HOST_CLEANUP_RETRY_MS = 10 * 60_000;

/** Start (or resume) removing a node. Returns immediately; progress is on the node record. */
export async function beginRemoval(id: string): Promise<void> {
  const node = await mustGet(id);
  if (isDeploying(id)) throw new Error('This node is still being deployed. Cancel the deploy instead; it reclaims the funds itself.');
  // T7: removal stops the container; a config change recreating it at the same time would undo that.
  const change = configChange.current(id);
  if (change && !node.removalStage) throw new Error(nodeBusyMessage(change));
  // Not on chain yet (deploy failed or still running): nothing to redeem, but a
  // container may exist, the key may hold the funding, and an unconfirmed open_node
  // may still have bonded (delist reads the chain first).
  const first: RemovalStage = firstRemovalStage(node);
  if (!node.removalStage) await updateNode(id, { removalStage: first, status: 'loading' });
  void advanceRemoval(id).catch((err: unknown) => log.error('removal step failed — will retry on next poll', { id, err: (err as Error).message }));
}

/** Drop a node record (+ local data). `forget` skips every chain step. */
export async function removeNode(id: string, opts: { forget?: boolean } = {}): Promise<void> {
  if (!opts.forget) {
    await beginRemoval(id);
    return;
  }
  const store = await readStore();
  const dropped = store.nodes.find((n) => n.id === id);
  store.nodes = store.nodes.filter((n) => n.id !== id);
  delete store.logs[id];
  delete store.nodeBackups[id];
  // Keep the key OWNER (never a secret) after the record goes: a directory left on a
  // host outlives the record, and without this address it could never be proven empty
  // and so could never be safely deleted.
  if (dropped?.operatorAddress) {
    store.retiredNodeOwners = { ...(store.retiredNodeOwners ?? {}), [id]: dropped.operatorAddress };
  }
  await writeStore(store);
  await removePath(localNodeDir(id), true).catch((err: unknown) =>
    log.warn('node dir cleanup failed', { id, err: (err as Error).message }),
  );
  purgeNode(id);
  sshKeyring.delete(id);
  startedAt.delete(id);
  broadcast(IPC.NODES_CHANGED, null);
}

/**
 * Advance the removal stage machine as far as possible right now.
 *   redeem → stop → delist → close → unbonding (time-gated) → withdraw-bond → sweep → done
 */
export async function advanceRemoval(id: string, opts: { force?: boolean } = {}): Promise<void> {
  if (removalsInFlight.has(id)) return;
  removalsInFlight.add(id);
  try {
    let force = opts.force ?? false;
    for (;;) {
      const node = await getNode(id);
      if (!node?.removalStage) return;
      const stage = node.removalStage;
      let next: RemovalStage;
      try {
        next = stage === 'done' ? 'done' : await runRemovalStage(node, stage, force);
      } catch (err) {
        // Persist the reason so the removal card shows it instead of "Working…".
        const message = (err as Error).message;
        if (node.removalError?.message !== message || node.removalError.stage !== stage) {
          await updateNode(id, { removalError: { stage, message, at: Date.now() } }).catch((e: unknown) =>
            log.warn('saving removal error failed', { id, err: (e as Error).message }),
          );
        }
        throw err;
      }
      // `force` is the user's one nudge: it must not make the loop ignore the backoff
      // again on a later pass, or a permanently unreachable host would spin.
      force = false;
      if (next !== stage) await updateNode(id, { removalStage: next, status: statusWhileRemoving(next, node.status), removalError: undefined });
      if (next === 'done') {
        // The key backup is deleted below; never do that while value is still on the key.
        if (!(await keyIsEmpty(node.operatorAddress))) {
          await sweepNodeKey(id);
          if (!(await keyIsEmpty(node.operatorAddress))) throw new Error('node key still holds funds after the sweep; keeping the record');
        }
        await addEvent({ kind: 'node-removed', title: `Node ${node.moniker} removed`, subtitle: 'Bond returned and node key swept to the wallet', relatedNodeId: id });
        await removeNode(id, { forget: true });
        return;
      }
      if (next === stage) return; // waiting (unbonding) — the poller resumes later
    }
  } finally {
    removalsInFlight.delete(id);
  }
}

async function runRemovalStage(node: DeployedNode, stage: RemovalStage, force = false): Promise<RemovalStage> {
  switch (stage) {
    case 'redeem': {
      // Settle outstanding vouchers so no earned revenue is lost; non-fatal.
      const running = await withHost(node, (rt) => rt.isRunning()).catch((err: unknown) => {
        log.debug('redeem stage: isRunning failed, skipping redeem', { id: node.id, err: (err as Error).message });
        return false;
      });
      if (running) await withHost(node, (rt) => daemonRedeem(rt)).catch((err: unknown) => logCtlFailure('final redeem', err));
      return 'stop';
    }
    case 'stop': {
      // The daemon would re-list on its next heartbeat, so it must stop first.
      await withHost(node, async (rt) => {
        await rt.removeContainer();
        if (await rt.isRunning()) throw new Error('the node container is still running after docker rm -f; retrying');
      }).catch(async (err: unknown) => {
        if (node.target === 'local' && isDockerUnavailable(err)) {
          // Fix G: with this computer's Docker down the container cannot be running, so
          // delisting is safe now. It is deleted when Docker is back (pruneStaleLocalContainers),
          // before its restart policy can keep a daemon around.
          await rememberStaleLocalContainer(node);
          log.info('local Docker is down; removal continues, the node container is deleted once Docker is back', { id: node.id });
          return;
        }
        if (node.target === 'remote' && !getSSH(node.id)) throw new Error(`Reconnect over SSH to ${node.host} so the node container can be stopped before delisting.`);
        throw err;
      });
      return 'delist';
    }
    case 'delist': {
      if (!node.nodePda) return 'close';
      const c = await chainNode(node);
      if (c && c.status === 1) {
        await ensureNodeKeyGas(node);
        const sig = await withChainCtl(node, (rt) => delistNode(rt, node.nodePda!));
        await addEvent({ kind: 'node-delisted', title: `${node.moniker} delisted`, subtitle: explorerTx(sig), relatedNodeId: node.id, txHash: sig });
      }
      return 'close';
    }
    case 'close': {
      if (!node.nodePda || !node.chainNodeId) return 'sweep'; // never opened: no bond, nothing to unbond
      const c = await chainNode(node);
      if (c) await ensureNodeKeyGas(node);
      const ubPda = nodeUnbondingPda(node.operatorAddress, node.chainNodeId);
      const { params, ub } = await withChainCtl(node, async (rt) => {
        const params = await cachedParams(rt);
        let closedNow = false;
        if (c) {
          const sig = await closeNode(rt, node.nodePda!, node.operatorAddress);
          closedNow = true;
          await addEvent({ kind: 'node-closed', title: `${node.moniker} closed — bond unbonding`, subtitle: `withdrawable after ${params.unbondingSeconds / 60} min`, relatedNodeId: node.id, txHash: sig });
        }
        // Read the unbonding account by its derived address: a scan can come back
        // empty from a lagging RPC, and that must never be read as "no bond".
        const ub = await showUnbonding(rt, ubPda);
        if (!ub && closedNow) throw new Error('close_node landed but the unbonding account is not visible yet; retrying');
        return { params, ub };
      });
      if (!ub && c) throw new Error('node account exists but no unbonding account was found; retrying');
      const unbondsAt = ub ? new Date((ub.closedAt + params.unbondingSeconds) * 1000).toISOString() : new Date().toISOString();
      await updateNode(node.id, { unbondingPda: ub?.address ?? ubPda, unbondsAt });
      return ub ? 'unbonding' : 'sweep';
    }
    case 'unbonding': {
      if (node.unbondsAt && Date.parse(node.unbondsAt) + 15_000 > Date.now()) return 'unbonding';
      return 'withdraw-bond';
    }
    case 'withdraw-bond': {
      if (!node.chainNodeId) return 'sweep';
      await ensureNodeKeyGas(node);
      await withChainCtl(node, async (rt) => {
        const ub = await showUnbonding(rt, node.unbondingPda ?? nodeUnbondingPda(node.operatorAddress, node.chainNodeId!));
        if (!ub) return; // already withdrawn (idempotent retry)
        const params = await cachedParams(rt);
        const sig = await withdrawNodeBond(rt, {
          unbonding: ub.address,
          owner: node.operatorAddress,
          ownerToken: tokenAccount(node.operatorAddress).toBase58(),
          vault: params.vault,
        });
        log.info('bond withdrawn', { id: node.id, amountBase: String(ub.amount), sig });
        await addEvent({ kind: 'bond-withdrawn', title: `Bond returned for ${node.moniker}`, subtitle: `${baseToDisplay(ub.amount)} tDVPN`, relatedNodeId: node.id, txHash: sig, amountDVPN: baseToDisplay(ub.amount) });
      });
      return 'sweep';
    }
    case 'sweep': {
      // A cleanup that already failed for want of credentials would fail identically on
      // every poll tick, so the POLLER retries it on a slow cadence. `force` is the user
      // asking for it now (Reconnect, or "finish removal"): making them wait out a
      // backoff after they just supplied the missing credentials is the stuck-looking
      // behaviour this whole fix exists to remove.
      if (
        !shouldRetryHostCleanup({
          lastAttemptAt: node.pendingHostCleanup?.at,
          now: Date.now(),
          retryMs: HOST_CLEANUP_RETRY_MS,
          force,
        })
      ) {
        return 'sweep';
      }
      // On a retry the funds are already home: topping the key up again would only
      // bleed SOL into a key we are abandoning, so only touch it while it holds value.
      if (!node.pendingHostCleanup || !(await keyIsEmpty(node.operatorAddress))) {
        await ensureNodeKeyGas(node);
        await sweepNodeKey(node.id);
      }
      // Host cleanup is the last thing left and it is NOT best-effort on a remote box:
      // the node record is the only place that knows which ufw rules and which home
      // directory are ours, so dropping it after a failed cleanup orphans them for good.
      // Both steps are attempted even if the first fails, so a permanently broken ufw
      // call can never stop the node directory from being deleted (and vice versa);
      // whatever did not land is what gets retried.
      let firewallStillOpen = Boolean(node.firewallOpened);
      const hostErr = await withHost(node, async (rt) => {
        const errs: string[] = [];
        if (firewallStillOpen) {
          await rt.closePorts(await portsToClose(node, nodePorts(node))).then(
            async () => {
              // Recorded immediately: a later removeHome failure must not make the app
              // re-close rules that are already gone.
              firewallStillOpen = false;
              await updateNode(node.id, { firewallOpened: false });
            },
            (err: unknown) => errs.push(`firewall rules: ${(err as Error).message}`),
          );
        }
        await rt.removeHome().catch((err: unknown) => errs.push(`node directory: ${(err as Error).message}`));
        return errs.length ? new Error(errs.join('; ')) : null;
      }).catch((err: unknown) => err as Error);
      if (!hostErr) {
        if (node.pendingHostCleanup) await updateNode(node.id, { pendingHostCleanup: undefined });
        return 'done';
      }
      if (!hostCleanupMustBeRetried(node.target)) {
        // Local host: nothing is hidden from the user and no remote box is left dirty.
        log.warn('node home cleanup skipped', { id: node.id, err: hostErr.message });
        return 'done';
      }
      await updateNode(node.id, {
        pendingHostCleanup: {
          reason: hostErr.message,
          at: Date.now(),
          ports: firewallStillOpen ? nodePorts(node) : undefined,
        },
      });
      log.warn('remote host cleanup pending; keeping the record so Reconnect can finish it', { id: node.id, err: hostErr.message });
      return 'sweep';
    }
    case 'done':
      return 'done';
  }
}

// ─── Background errors the user must see (fix F) ───

/** Persist a background failure on the node so its page shows it (never only the log). */
export async function noteNodeError(id: string, what: string, err: unknown): Promise<void> {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 400);
  const node = await getNode(id);
  if (!node) return;
  if (node.lastError?.what === what && node.lastError.message === message) return;
  await updateNode(id, { lastError: { what, message, at: Date.now() } });
}

/** Clear the node's lastError once the same job succeeds again. */
export async function clearNodeError(id: string, what: string): Promise<void> {
  const node = await getNode(id);
  if (node?.lastError?.what === what) await updateNode(id, { lastError: undefined });
}

const pollFailures = new Map<string, number>();

// ─── Containers left behind while Docker was down (fix G) ───

async function rememberStaleLocalContainer(node: DeployedNode): Promise<void> {
  const s = await readStore();
  const list = s.staleLocalContainers ?? [];
  if (!list.some((c) => c.nodeId === node.id)) list.push({ nodeId: node.id, runtimeId: node.runtimeId, at: new Date().toISOString() });
  s.staleLocalContainers = list;
  await writeStore(s);
}

let lastStalePruneFailure = 0;

/** Delete containers of removed local nodes once Docker is reachable again. Quiet while it is down. */
export async function pruneStaleLocalContainers(): Promise<number> {
  const s = await readStore();
  const list = s.staleLocalContainers ?? [];
  if (!list.length) return 0;
  const left: typeof list = [];
  let removed = 0;
  for (const c of list) {
    try {
      // By name first (what node-runtime creates), then by the recorded id.
      await withDockerTimeout(() => removeLocalContainer(containerName(c.nodeId)), 60_000, 'removeContainer');
      if (c.runtimeId) await withDockerTimeout(() => removeLocalContainer(c.runtimeId!), 60_000, 'removeContainer');
      removed++;
      log.info('left-behind node container deleted', { id: c.nodeId });
    } catch (err) {
      left.push(c);
      if (!isDockerUnavailable(err) && Date.now() - lastStalePruneFailure > 3_600_000) {
        lastStalePruneFailure = Date.now();
        log.warn('could not delete a left-behind node container; retrying', { id: c.nodeId, err: (err as Error).message });
      }
    }
  }
  if (removed) {
    const fresh = await readStore();
    fresh.staleLocalContainers = (fresh.staleLocalContainers ?? []).filter((c) => left.some((l) => l.nodeId === c.nodeId));
    await writeStore(fresh);
  }
  return removed;
}

/** "Retry now" on the removal card (T1): run the current removal step immediately, skipping backoff. */
export async function retryRemovalNow(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const node = await mustGet(id);
    if (!node.removalStage) throw new Error('This node is not being removed.');
    if (removalsInFlight.has(id)) throw new Error('The removal is running right now. Try again in a minute.');
    await advanceRemoval(id, { force: true });
    const after = await getNode(id);
    if (after?.removalError) return { ok: false, error: after.removalError.message };
    if (after?.pendingHostCleanup) return { ok: false, error: after.pendingHostCleanup.reason };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Manual "withdraw bond now" (same as letting the poller do it once due). */
export async function withdrawBondNow(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const node = await mustGet(id);
    const blocked = withdrawBondBlocker(node.removalStage, Boolean(node.pendingHostCleanup));
    if (blocked) throw new Error(blocked);
    if (node.removalStage === 'unbonding' && node.unbondsAt && Date.parse(node.unbondsAt) + 15_000 > Date.now()) {
      throw new Error(`The bond unlocks at ${new Date(Date.parse(node.unbondsAt) + 15_000).toLocaleTimeString()}.`);
    }
    await advanceRemoval(id, { force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * The user says the node's server no longer exists: finish a removal that is parked on
 * host cleanup without it (forgetServerBlocker says when that is safe). The node owner
 * address stays in retiredNodeOwners, like any removed node.
 */
export async function forgetServerNow(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    if (removalsInFlight.has(id)) throw new Error('The removal is running right now. Try again in a minute.');
    const node = await mustGet(id);
    const blocked = forgetServerBlocker({
      removalStage: node.removalStage,
      pendingHostCleanup: Boolean(node.pendingHostCleanup),
      keyEmpty: await keyIsEmpty(node.operatorAddress),
    });
    if (blocked) throw new Error(blocked);
    log.warn('node removed without server cleanup (user: server is gone)', { id, host: node.host, ports: node.pendingHostCleanup?.ports });
    await addEvent({
      kind: 'node-removed',
      title: `Node ${node.moniker} removed`,
      subtitle: `Bond and node key were already back in your wallet; server cleanup skipped (${node.host ?? 'server'} is gone)`,
      relatedNodeId: id,
    });
    await removeNode(id, { forget: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── Live status ───

export async function liveStatus(id: string): Promise<NodeLiveStatus> {
  const node = await mustGet(id);
  const t0 = Date.now();
  const status: NodeLiveStatus = {
    nodeId: id,
    reachable: false,
    sessions: 0,
    bytesIn: 0,
    bytesOut: 0,
    uptimeMs: node.startedAt ? Date.now() - Date.parse(node.startedAt) : 0,
    logTail: [],
    activeSubscriptions: [],
    linkedPlans: [],
    configChange: configChange.current(id),
    sshDisconnected: node.target === 'remote' && !hasSSH(id) ? true : undefined,
    hnsImageOutdated: hnsImageOutdated(node) || undefined,
  };
  try {
    const conn = await connection();
    status.chainHeight = await withRetry(() => conn.getSlot(), 'getSlot', 3);
    const chain = await chainNode(node);
    status.apiLatencyMs = Date.now() - t0;
    if (chain) {
      status.chainAddress = chain.address;
      status.chainStatus = chain.status === 1 ? 'listed' : 'delisted';
      status.lastStatusAt = new Date(chain.listedAt * 1000).toISOString();
      // Listing TTL from the program (cached); 86 400 s is devnet's value and
      // only the fallback before the first parameter read.
      const params = { ttl: knownParams()?.nodeListingTtlSeconds ?? 86_400 };
      if (!knownParams()) void withChainCtl(node, (rt) => cachedParams(rt)).catch((err: unknown) => log.debug('params prefetch failed', { err: (err as Error).message }));
      status.listingExpiresAt = new Date((chain.listedAt + params.ttl) * 1000).toISOString();
      status.revenueDVPN = baseToDisplay(chain.revenue);
      status.feesAccruedDVPN = baseToDisplay(chain.feesAccrued);
      status.protocolBits = chain.protocols;
      status.chainPrices = {
        perGb: baseToDisplay(chain.prices.perGb),
        perHour: baseToDisplay(chain.prices.perHour),
        leasePerHour: baseToDisplay(chain.prices.leasePerHour),
      };
      status.chainUri = chain.uri;
      status.reachable = chain.status === 1 && chain.listedAt + params.ttl > Date.now() / 1000;
    } else {
      status.chainStatus = node.registeredOnChain ? 'not-found' : 'not-opened';
    }
    await refreshNodeBalances(node);
  } catch (err) {
    // NM-C9 T9 (h): a server node right after an app restart has no SSH session, so its chain read
    // falls back to this computer's Docker; on an SSH-only Win/mac machine that fails with a Docker
    // install hint that is wrong for a server node. Say what the user can do instead.
    status.error = status.sshDisconnected && status.chainStatus === undefined
      ? `Reconnect ${node.moniker} (Nodes → node → Reconnect) to read its chain status from its server.`
      : (err as Error).message;
  }
  if (!node.removalStage || node.removalStage === 'redeem') {
    try {
      await withHost(node, async (rt) => {
        status.logTail = await rt.logs(60);
        if (await rt.isRunning()) {
          const sessions = await daemonSessions(rt);
          status.sessions = sessions.length;
          status.activeSubscriptions = sessions.map(summarizeSession).filter((s): s is NodeSession => !!s);
          for (const s of status.activeSubscriptions) {
            status.bytesIn += s.bytesIn;
            status.bytesOut += s.bytesOut;
          }
          // Leases the daemon watches (providers pre-paying this node per hour).
          const positions = await daemonPositions(rt).catch((err: unknown) => {
            log.debug('positions read failed', { id, err: (err as Error).message });
            return [] as unknown[];
          });
          status.linkedPlans = positions
            .map((p) => summarizeLease(p as Record<string, unknown>))
            .filter((l): l is NodePlanLink => !!l);
          if (node.handshakeDns) {
            const probe = await hnsProbe(rt).catch((err: unknown) => {
              log.debug('hnsd probe failed', { id, err: (err as Error).message });
              return undefined;
            });
            status.hnsdRunning = probe?.hnsd;
            status.hnsRouting = probe?.routing;
            if (probe) status.hnsSync = { ...hnsSyncState(probe.sync), height: probe.sync?.height, ageSec: probe.sync?.ageSec };
            // hnsd came up after all (slow first start): drop the stale "not running" reason.
            if (status.hnsdRunning && node.hnsdError) await updateNode(id, { hnsdError: undefined });
          }
        } else {
          status.reachable = false;
        }
      });
    } catch (err) {
      status.error = status.error ?? (err as Error).message;
    }
  }
  return status;
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

function summarizeSession(raw: Record<string, unknown>): NodeSession | null {
  const id = String(raw.id ?? raw.ID ?? raw.session_id ?? '');
  if (!id) return null;
  const subscriber = String(raw.client ?? raw.peer ?? raw.owner ?? raw.channel ?? raw.position ?? '');
  const started = num(raw.started_at ?? raw.startedAt ?? raw.created_at);
  return {
    id,
    subscriber,
    subscriberShort: subscriber ? `${subscriber.slice(0, 6)}…${subscriber.slice(-4)}` : '—',
    bytesIn: num(raw.rx ?? raw.rx_bytes ?? raw.download_bytes ?? raw.bytes_in),
    bytesOut: num(raw.tx ?? raw.tx_bytes ?? raw.upload_bytes ?? raw.bytes_out),
    durationSeconds: started ? Math.max(0, Math.floor(Date.now() / 1000 - (started > 1e12 ? started / 1000 : started))) : 0,
    status: raw.status !== undefined ? String(raw.status) : undefined,
  };
}

/** A daemon position of kind "lease" → the Leases card row (null for channels). */
function summarizeLease(raw: Record<string, unknown>): NodePlanLink | null {
  const kind = String(raw.kind ?? raw.Kind ?? '').toLowerCase();
  if (kind !== 'lease') return null;
  const id = String(raw.address ?? raw.Address ?? '');
  if (!id) return null;
  const escrow = num(raw.escrow ?? raw.Escrow);
  const redeemed = num(raw.redeemed ?? raw.Redeemed);
  const opened = num(raw.openedAt ?? raw.opened_at ?? raw.OpenedAt);
  const openedMs = opened > 1e12 ? opened : opened * 1000;
  return {
    id,
    denom: 'tDVPN',
    price: baseToDisplay(Math.max(0, escrow - redeemed)),
    durationDays: opened ? Math.max(0, Math.floor((Date.now() - openedMs) / 86_400_000)) : 0,
    provider: typeof raw.owner === 'string' ? raw.owner : typeof raw.provider === 'string' ? raw.provider : undefined,
    status: raw.status !== undefined ? String(raw.status) : undefined,
  };
}

/** Leases on this node as the program stores them (`lease search --node`). */
export async function nodeLeases(id: string): Promise<NodePlanLink[]> {
  const node = await mustGet(id);
  if (!node.nodePda) throw new Error('This node is not on chain yet.');
  const leases = await withChainCtl(node, (rt) => searchLeases(rt, node.nodePda!));
  return leases.map(leaseLink);
}

function leaseLink(l: ChainLease): NodePlanLink {
  const openedMs = l.openedAt ? (l.openedAt > 1e12 ? l.openedAt : l.openedAt * 1000) : 0;
  return {
    id: l.address,
    denom: 'tDVPN',
    price: baseToDisplay(l.escrow),
    durationDays: openedMs ? Math.max(0, Math.floor((Date.now() - openedMs) / 86_400_000)) : 0,
    provider: l.provider,
    status: l.status !== undefined ? String(l.status) : undefined,
  };
}

export function historyFor(id: string, window: MetricsWindow): MetricsSample[] {
  return history(id, window);
}

// ─── Poller ───

let pollerTick: (() => Promise<void>) | null = null;

export function startPoller(): void {
  if (poller) return;
  void listNodes().then((nodes) => {
    for (const n of nodes) {
      if (n.startedAt) startedAt.set(n.id, Date.parse(n.startedAt));
      if (n.removalStage) {
        // A record saved before the Q0328 fix can still say "online"; correct it now,
        // not only at the next stage advance (which may be an hour away while unbonding).
        const fixed = statusWhileRemoving(n.removalStage, n.status);
        const normalise = fixed === n.status ? Promise.resolve() : updateNode(n.id, { status: fixed });
        void normalise
          .then(() => advanceRemoval(n.id))
          .catch((err: unknown) => log.warn('resume removal failed', { id: n.id, err: (err as Error).message }));
      }
    }
  });
  let ticking = false;
  const tick = async () => {
    if (ticking) return; // a slow tick (one container run per node) must not overlap the next
    ticking = true;
    try {
      await tickOnce();
    } finally {
      ticking = false;
    }
  };
  const tickOnce = async () => {
    await pruneStaleLocalContainers().catch((err: unknown) => log.warn('stale container prune failed', { err: (err as Error).message }));
    for (const node of await listNodes()) {
      try {
        if (isDeploying(node.id)) continue;
        if (node.removalStage) {
          await advanceRemoval(node.id);
          // NM-C9 (a): this branch skipped the clear below, so a removal step that failed while the
          // app had no SSH kept its red "Status check failed" banner an hour after it succeeded.
          if (pollFailures.delete(node.id)) await clearNodeError(node.id, 'Status check');
          continue;
        }
        if (!node.registeredOnChain) continue;
        const status = await liveStatus(node.id);
        broadcast(IPC.NODES_LIVE_STATUS, { nodeId: node.id, status });
        recordSample({
          nodeId: node.id,
          ts: Date.now(),
          peers: status.sessions,
          bytesIn: status.bytesIn,
          bytesOut: status.bytesOut,
          earningsUdvpn: Math.round((status.revenueDVPN ?? 0) * 1_000_000),
          chainHeight: status.chainHeight,
          reachable: status.reachable,
        });
        if (status.reachable && node.status !== 'online' && node.status !== 'offline') {
          await transition(node.id, 'online');
          await addEvent({ kind: 'node-online', title: `Node ${node.moniker} is online`, subtitle: 'Listed on Solana devnet', relatedNodeId: node.id });
        } else if (!status.reachable && node.status === 'online' && !(status.sshDisconnected && status.chainStatus === undefined)) {
          // A server node with no SSH session whose chain read failed: unknown, not 'not live' (T9 h).
          const sinceStart = Date.now() - (startedAt.get(node.id) ?? 0);
          if (sinceStart > 120_000) {
            await transition(node.id, 'error');
            await addEvent({ kind: 'node-unreachable', title: `Node ${node.moniker} is not live`, subtitle: status.error ?? `chain status ${status.chainStatus}`, relatedNodeId: node.id });
          }
        }
        if (pollFailures.delete(node.id)) await clearNodeError(node.id, 'Status check');
      } catch (err) {
        // One miss is noise; three in a row is something the user must see (fix F).
        const n = (pollFailures.get(node.id) ?? 0) + 1;
        pollFailures.set(node.id, n);
        log.debug('poll node failed', { id: node.id, n, err: (err as Error).message });
        if (n === 3) {
          log.warn('status check keeps failing', { id: node.id, err: (err as Error).message });
          await noteNodeError(node.id, 'Status check', err).catch((e: unknown) => log.warn('saving node error failed', { id: node.id, err: (e as Error).message }));
        }
      }
    }
  };
  setTimeout(() => void tick(), 5_000);
  pollerTick = tick;
  void getSettings()
    .then((s) => armPoller(s.nodeRefreshIntervalSec))
    .catch((err: unknown) => {
      log.warn('settings read failed; poller at 60s', { err: (err as Error).message });
      armPoller(60);
    });
}

function armPoller(intervalSec: number): void {
  if (poller) clearInterval(poller);
  poller = null;
  if (!pollerTick) return;
  const ms = Math.max(15, Math.min(600, Math.round(intervalSec))) * 1000;
  poller = setInterval(() => {
    if (pollerTick) void pollerTick();
  }, ms);
}

export function restartPollerCadence(intervalSec: number): void {
  armPoller(intervalSec);
}

export function stopPoller(): void {
  if (poller) clearInterval(poller);
  poller = null;
  pollerTick = null;
}

// ─── Stuck-node housekeeping ───

/** Drop local nodes that never got on chain and whose container is not running. */
export async function reapStuckNow(): Promise<number> {
  const store = await readStore();
  let dropped = 0;
  for (const n of [...store.nodes]) {
    if (n.target !== 'local' || n.registeredOnChain || n.removalStage || isDeploying(n.id)) continue;
    const up = n.runtimeId
      ? await withDockerTimeout(() => isRunning(n.runtimeId!), 5_000, 'isRunning').catch((err: unknown) => {
          log.debug('reap: isRunning failed, treating as down', { id: n.id, err: (err as Error).message });
          return false;
        })
      : false;
    if (up) continue;
    // Never strand funds: the key is swept back first, and the record (with the
    // only key backup) is dropped only once the key is verifiably empty.
    try {
      if (!(await keyIsEmpty(n.operatorAddress))) await sweepNodeKey(n.id);
      if (!(await keyIsEmpty(n.operatorAddress))) throw new Error('key still holds funds after the sweep');
    } catch (err) {
      log.warn('reap: keeping node record, its key is not empty', { id: n.id, err: (err as Error).message });
      continue;
    }
    await removeNode(n.id, { forget: true });
    dropped++;
  }
  return dropped;
}

export interface HostLeftover {
  nodeId: string;
  /** Node key owner, when the node is still in the e2e/app records. */
  owner?: string;
  removed: boolean;
  /** Why it was left in place. */
  kept?: string;
}

/**
 * Find and (unless `dryRun`) delete node-home directories a host still holds for
 * nodes this app no longer tracks.
 *
 * Removal abandoned these whenever its host cleanup could not run, and because the
 * node record is the only thing that knows a directory is ours, nothing afterwards
 * could find them — six were sitting on the remote test host. A directory holds the
 * node key, so one is deleted ONLY when no app record claims it and its key is
 * verifiably empty on chain; anything else is reported and left alone.
 */
export async function cleanHostLeftovers(
  creds: SSHCredentials | undefined,
  opts: { dryRun?: boolean } = {},
): Promise<{ host: string; found: HostLeftover[] }> {
  const nodes = await listNodes();
  // Any record at all protects a directory, including one mid-removal or mid-deploy.
  const claimed = new Set(nodes.map((n) => n.id));
  // The target comes from what the CALLER asked for, never from whichever record
  // happens to be first: openRuntime dispatches on `target` alone, so borrowing a
  // local record while `creds` names a remote host would quietly scan — and delete
  // from — THIS machine while reporting the remote host's name.
  const target: NodeDeployTarget = creds ? 'remote' : 'local';
  // Only the shared home base is used below, but the runtime needs a node id for its
  // paths; any node on this same host does, else a placeholder that owns nothing.
  const anchor = nodes.find((n) => n.target === target && (target === 'local' || n.host === creds?.host));
  const rt = await openRuntime(
    {
      id: anchor?.id ?? '00000000-0000-0000-0000-000000000000',
      target,
      host: creds?.host,
      runtimeId: undefined,
    },
    creds,
  );
  try {
    const retired = (await readStore()).retiredNodeOwners ?? {};
    const found: HostLeftover[] = [];
    for (const nodeId of await rt.listHomes()) {
      // The app's own scratch runtimes live here too and are in active use.
      if (isReservedRuntimeHome(nodeId)) continue;
      const owner = retired[nodeId];
      const claimedByRecord = claimed.has(nodeId);
      // The chain is only consulted once the cheap checks allow a deletion at all.
      const keyEmpty = !claimedByRecord && owner ? await keyIsEmpty(owner) : false;
      const verdict = leftoverVerdict({ claimedByRecord, owner, keyEmpty, dryRun: opts.dryRun });
      if (verdict.act === 'skip') continue;
      if (verdict.act === 'keep') {
        found.push({ nodeId, owner, removed: false, kept: verdict.reason });
        continue;
      }
      await rt.removeHomeById(nodeId);
      // Nothing of this node is left anywhere, so the tombstone has no more work to do.
      const s = await readStore();
      if (s.retiredNodeOwners?.[nodeId]) {
        delete s.retiredNodeOwners[nodeId];
        await writeStore(s);
      }
      found.push({ nodeId, owner, removed: true });
    }
    return { host: rt.label, found };
  } finally {
    await rt.close();
  }
}

// ─── Node-role reads (sessions, positions, redemptions, inspect, daemon) ───

async function withRunningDaemon<T>(id: string, fn: (rt: NodeRuntime) => Promise<T>): Promise<T> {
  const node = await mustGet(id);
  return withHost(node, async (rt) => {
    if (!(await rt.isRunning())) throw new Error('The node is not running; start it first.');
    return fn(rt);
  });
}

export const nodeSessions = (id: string) => withRunningDaemon(id, (rt) => daemonSessions(rt));
export const nodeSession = (id: string, sid: string) => withRunningDaemon(id, (rt) => daemonSession(rt, sid));
export const nodePositions = (id: string) => withRunningDaemon(id, (rt) => daemonPositions(rt));
export const nodeRedemptions = (id: string) => withRunningDaemon(id, (rt) => daemonRedemptions(rt));
export const nodeDaemonInfo = (id: string) => withRunningDaemon(id, (rt) => daemonInfo(rt));

/** Close a session the node is serving (also clears a stale peer slot → peer_limit_reached). */
export async function closeNodeSession(id: string, sid: string): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  try {
    const result = await withRunningDaemon(id, (rt) => daemonCloseSession(rt, sid));
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Verify the node's signed metadata + TLS pin the way a client does, and that it is discoverable. */
/** Does the node answer its own API on its host (inside the container)? Undefined when that cannot be checked. */
export async function nodeAnswersOnHost(node: DeployedNode): Promise<boolean | undefined> {
  try {
    return await withHost(node, async (rt) => {
      if (!(await rt.isRunning())) return false;
      const r = await rt.exec(['curl', '-sk', '-m', '5', '-o', '/dev/null', '-w', '%{http_code}', `https://127.0.0.1:${node.port}/v1/metadata`], 20_000);
      return r.exitCode === 0 && /^[1-5]\d\d$/.test(r.output.trim().slice(-3));
    });
  } catch (err) {
    log.debug('on-host self check unavailable', { id: node.id, err: (err as Error).message });
    return undefined;
  }
}

export async function inspectNodeTrust(id: string): Promise<{
  inspect?: unknown;
  reachable: boolean;
  tlsPinMatches?: boolean;
  discoverable: boolean;
  /** The node answers on its own host (checked only when unreachable from here). */
  answersOnHost?: boolean;
  /** Unreachable from here although the node works on its host and the host firewall is handled: upstream filter. */
  blockedUpstream?: boolean;
  error?: string;
  guidance?: string;
}> {
  const node = await mustGet(id);
  if (!node.nodePda) throw new Error('This node is not on chain yet.');
  // Run from THIS machine, like a client would: a node that is listed but cannot be
  // reached here is invisible to real users too.
  let inspect: unknown;
  let error: string | undefined;
  try {
    inspect = await withChainCtl(node, (rt) => inspectNode(rt, node.nodePda!));
  } catch (err) {
    error = (err as Error).message;
  }
  const reachable = inspect !== undefined;
  const text = JSON.stringify(inspect ?? {});
  const tlsPinMatches = reachable && node.tlsSha256 ? text.toLowerCase().includes(node.tlsSha256.toLowerCase()) : undefined;
  const found = await withChainCtl(node, (rt) =>
    ctl<Array<{ address: string }>>(rt, ['node', 'search', '--owner', node.operatorAddress, '--status', 'listed'], 'searching listed nodes'),
  );
  const answersOnHost = reachable ? undefined : await nodeAnswersOnHost(node);
  const blockedUpstream = !reachable && answersOnHost === true;
  const range = `${node.port}–${node.port + PORT_BLOCK_SIZE - 1}`;
  const guidance = reachable
    ? undefined
    : blockedUpstream
      ? `The node works on its host (it answers https://127.0.0.1:${node.port} there${node.firewallOpened ? ' and the host ufw rules are in place' : ''}) but clients cannot reach https://${node.remoteUrl}:${node.port}: the block is upstream of the host. Open TCP+UDP ${range} in the cloud provider's firewall / security group (or the router in front of it). The app cannot change that.`
      : answersOnHost === false
        ? `The node does not answer on its own host — check the container logs (nodes.logs); this is not a firewall problem.`
        : `Clients cannot reach https://${node.remoteUrl}:${node.port}. Open TCP+UDP ${range} in your router, the host firewall and the cloud provider firewall.`;
  return { inspect, reachable, tlsPinMatches, discoverable: found.some((n) => n.address === node.nodePda), answersOnHost, blockedUpstream, error, guidance };
}

/**
 * Program parameters + pause mask + the node image's link-time identity,
 * read with a key-less dvpnctl home (read-only; nothing is signed).
 */
export async function programOverview(): Promise<{ params: unknown; status: unknown; image: unknown }> {
  const rt = await openRuntime({ id: '00000000-0000-4000-8000-0000000000a0', target: 'local', runtimeId: undefined, host: undefined, imageTag: await chainCtlImageTag() });
  try {
    await rt.prepare();
    await rt.writeFile('ctl/config.toml', ctlConfigToml(await pickRPC()), 0o600);
    const params = await cachedParams(rt);
    const status = await programStatus(rt);
    const image = await ctlVersion(rt);
    return { params, status, image };
  } finally {
    await rt.removeHome().catch((err: unknown) => log.debug('scratch ctl home cleanup failed', { err: (err as Error).message }));
    await rt.close();
  }
}

// ─── SSH reconnect (credentials are memory-only by design) ───

export function hasSSH(nodeId: string): boolean {
  return sshKeyring.has(nodeId);
}

/**
 * Re-attach SSH credentials after an app restart. Verifies them with a real
 * connection, then remembers them (in memory only) for every node on that host,
 * so stalled removals and host operations resume on the next poll.
 */
export async function reconnectHost(creds: SSHCredentials): Promise<{ ok: boolean; nodes: string[]; error?: string }> {
  const { testSSHConnection } = await import('./ssh');
  const t = await testSSHConnection(creds);
  if (!t.ok) return { ok: false, nodes: [], error: t.message };
  const nodes = (await listNodes()).filter((n) => n.target === 'remote' && n.host === creds.host);
  for (const n of nodes) {
    sshKeyring.set(n.id, creds);
    // force: the user just supplied the credentials the cleanup was waiting for.
    if (n.removalStage) void advanceRemoval(n.id, { force: true }).catch((err: unknown) => log.warn('resume removal after reconnect failed', { id: n.id, err: (err as Error).message }));
  }
  broadcast(IPC.NODES_CHANGED, null);
  return { ok: true, nodes: nodes.map((n) => n.moniker) };
}
