import { randomUUID } from 'node:crypto';
import type { DeployedNode, RecoveryHostOutcome, SSHCredentials, VpnServiceType } from '../../shared/types';
import { baseToDisplay } from './chain';
import { ctl, decodeNode, type ChainNode, type Wrapped } from './dvpnctl';
import { keypairFromJson } from './keys';
import { log } from './logger';
import { encodeKeypairBackup } from './node-backup';
import { getKey } from './node-config';
import { ensureNodePersisted, listNodes, reconnectHost, rememberSSH } from './node-manager';
import { openRuntime, type NodeRuntime } from './node-runtime';
import { PREBUILT_IMAGE_TAG } from './prebuilt-image';
import { forgetDiscovered } from './recovery';
import { testSSHConnection } from './ssh';
import { readStore, writeStore } from './store';
import { addEvent } from './events';
import { BrowserWindow } from 'electron';
import { IPC } from '../../shared/types';

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
}

/**
 * NM032 "Reconnect servers": take back the nodes a server runs when this app no longer lists them.
 *
 * Every node this app deploys keeps its whole home on its host, `~/.dvpnd-nodes/<node id>/`, with the
 * node key at `ctl/keys/owner.json` and its daemon config beside it (deploy.ts). With the user's SSH
 * login the app reads those, confirms the node on chain, and rebuilds the record it lost, keeping the
 * same node id so the container name and home path still line up. Nothing on the server is changed,
 * and nothing is ever deleted: a home without a key, or whose node is closed, is reported and left alone.
 */

const SERVICES: VpnServiceType[] = ['wireguard', 'amneziawg', 'v2ray', 'xray', 'openvpn', 'hysteria2'];

export type HostOutcome = RecoveryHostOutcome;

export interface AdoptHostResult {
  host: string;
  outcome: HostOutcome;
  message: string;
  /** Monikers of nodes added back to the list from this server. */
  adopted: string[];
  /** Nodes on this server the list already had (their login is attached now). */
  alreadyListed: string[];
  /** Node homes left alone, with the reason. */
  skipped: Array<{ home: string; reason: string }>;
  saved?: boolean;
  saveError?: string;
}

/** Sort an SSH failure into what the Reconnect window shows. */
import { classifySshFailure } from './ssh-failure';
export { classifySshFailure };

/** Host part of a node's on-chain uri (`https://1.2.3.4:41000` → `1.2.3.4`). */
export function hostFromUri(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  try {
    return new URL(uri.includes('://') ? uri : `https://${uri}`).hostname || undefined;
  } catch (err) {
    log.debug('node uri is not a URL', { uri, err: (err as Error).message });
    return undefined;
  }
}

export interface AdoptInput {
  id: string;
  creds: Pick<SSHCredentials, 'host' | 'port' | 'username'>;
  operator: string;
  /** The daemon config (cb33 `config.toml` or older `node/config.toml`). */
  config: string;
  chain: ChainNode;
  image?: string;
  running: boolean;
  moniker?: string;
  createdAt?: string;
}

/** The node record rebuilt from what its server and the chain say. Pure: unit-tested. */
export function buildAdoptedNode(i: AdoptInput): DeployedNode {
  const svc = (getKey(i.config, '', 'service') ?? '').replace(/"/g, '') as VpnServiceType;
  const serviceType: VpnServiceType = SERVICES.includes(svc) ? svc : 'wireguard';
  const apiPort = Number(getKey(i.config, 'api', 'port'));
  const port = Number.isInteger(apiPort) && apiPort > 0 ? apiPort : 0;
  const hns = (getKey(i.config, 'handshake_dns', 'enabled') ?? '').trim() === 'true';
  const moniker = i.moniker?.trim() || `Recovered node ${i.creds.host}${port ? `:${port}` : ''}`;
  return {
    id: i.id,
    name: moniker,
    moniker,
    target: 'remote',
    host: i.creds.host,
    sshPort: i.creds.port || 22,
    sshUser: i.creds.username,
    status: i.running ? 'online' : 'offline',
    region: i.creds.host,
    country: i.chain.country || undefined,
    createdAt: i.createdAt ?? (i.chain.openedAt ? new Date(i.chain.openedAt * 1000).toISOString() : new Date().toISOString()),
    operatorAddress: i.operator,
    balanceDVPN: 0,
    balanceSOL: 0,
    port,
    chainNodeId: i.chain.nodeIdHex,
    nodePda: i.chain.address,
    gigabytePriceDVPN: baseToDisplay(i.chain.prices.perGb),
    hourlyPriceDVPN: baseToDisplay(i.chain.prices.perHour),
    leaseHourlyPriceDVPN: baseToDisplay(i.chain.prices.leasePerHour),
    priceMode: 'flat',
    serviceType,
    imageTag: i.image ?? PREBUILT_IMAGE_TAG,
    registeredOnChain: true,
    remoteUrl: hostFromUri(i.chain.uri) ?? i.creds.host,
    handshakeDns: hns,
    recoveredAt: new Date().toISOString(),
  };
}

/**
 * Where a node home keeps its key, most durable first (Q0588). The deploy writes the node key once
 * to <keysDir>/<name>.json, named by the daemon's init (`operator`; cb33 keysDir `keys`, older
 * `node/keys`), root-owned 0600. ctl/keys/owner.json exists only while a chain command runs.
 */
export const NODE_KEY_CANDIDATES = ['keys/operator.json', 'node/keys/operator.json', 'ctl/keys/owner.json'] as const;

/** The first candidate that holds a valid keypair (read with sudo by the remote runtime), or null. */
async function readNodeKey(rt: NodeRuntime): Promise<{ keyJson: string; operator: string } | null> {
  for (const rel of NODE_KEY_CANDIDATES) {
    let text: string;
    try {
      text = (await rt.readFile(rel)).trim();
    } catch (err) {
      log.debug('reconnect server: no node key here', { rel, err: (err as Error).message });
      continue;
    }
    try {
      return { keyJson: text, operator: keypairFromJson(text).publicKey.toBase58() };
    } catch (err) {
      log.warn('reconnect server: file is not a node key, skipped', { rel, err: (err as Error).message });
    }
  }
  return null;
}

async function readConfig(rt: NodeRuntime): Promise<string> {
  // cb33 keeps everything in <home>/config.toml; older layouts keep the node part in node/config.toml.
  const top = await rt.readFile('config.toml');
  if (getKey(top, 'api', 'port') !== undefined || getKey(top, '', 'service') !== undefined) return top;
  return rt.readFile('node/config.toml');
}

/** The chain node owned by `operator`, read with the dvpnctl in the node's own image. */
async function chainNodeOf(rt: NodeRuntime, operator: string): Promise<ChainNode | null> {
  const rows = await ctl<Array<Wrapped<unknown>>>(rt, ['node', 'search', '--owner', operator], 'searching the node by its key');
  const nodes = rows.map(decodeNode).filter((n) => n.owner === operator);
  // A key opens one node; prefer a listed one if the chain ever shows more.
  return nodes.find((n) => n.status === 1) ?? nodes[0] ?? null;
}

/**
 * Log in to `creds.host`, re-attach the login to the nodes the list already has there, and add back
 * every node home the list is missing. `remember` keeps the login (encrypted) when it worked.
 */
export async function adoptHost(creds: SSHCredentials, opts: { remember?: boolean } = {}): Promise<AdoptHostResult> {
  const host = creds.host;
  const base: AdoptHostResult = { host, outcome: 'error', message: '', adopted: [], alreadyListed: [], skipped: [] };

  const t = await testSSHConnection(creds);
  if (!t.ok) {
    const outcome = classifySshFailure(t.message);
    log.warn('reconnect server: login failed', { host, outcome, err: t.message });
    return { ...base, outcome, message: t.message };
  }

  // Nodes the list already has on this host get the login (and it is saved if asked).
  const re = await reconnectHost(creds, opts);
  base.saved = re.saved;
  base.saveError = re.saveError;
  base.alreadyListed = re.nodes;

  const listed = await listNodes();
  const listedIds = new Set(listed.map((n) => n.id));
  const listedOwners = new Set(listed.map((n) => n.operatorAddress));
  const discovered = new Map(((await readStore()).discoveredNodes ?? []).map((d) => [d.operatorAddress, d]));

  // Any id opens a runtime on this host; listHomes reads the shared base. init() creates nothing.
  let homes: string[];
  const probe = await openRuntime({ id: randomUUID(), target: 'remote', host, runtimeId: undefined, imageTag: PREBUILT_IMAGE_TAG }, creds);
  try {
    homes = await probe.listHomes();
  } finally {
    await probe.close();
  }

  const adoptedOwners: string[] = [];
  for (const home of homes) {
    if (listedIds.has(home)) continue;
    let rt: NodeRuntime | null = null;
    try {
      rt = await openRuntime({ id: home, target: 'remote', host, runtimeId: undefined, imageTag: PREBUILT_IMAGE_TAG }, creds);
      const key = await readNodeKey(rt);
      if (!key) {
        base.skipped.push({ home, reason: 'no node key in this folder (left alone)' });
        log.info('reconnect server: home without a key left alone', { host, home });
        continue;
      }
      const { keyJson, operator } = key;
      if (listedOwners.has(operator)) {
        base.skipped.push({ home, reason: 'this node is already in the list' });
        continue;
      }
      const image = await rt.containerImage();
      if (image) rt.imageTag = image;
      const chain = await chainNodeOf(rt, operator);
      if (!chain) {
        base.skipped.push({ home, reason: 'no open node on chain for this key (removed or never opened; left alone)' });
        continue;
      }
      const config = await readConfig(rt);
      const running = await rt.isRunning();
      const found = discovered.get(operator);
      const node = buildAdoptedNode({
        id: home,
        creds,
        operator,
        config,
        chain,
        image,
        running,
        moniker: found?.moniker,
        createdAt: found?.fundedAt,
      });
      // Login first (a status poll in between warned "no SSH credentials"), then the key backup, then the
      // node: a crash between two writes must never leave a listed node without its key.
      rememberSSH(home, creds);
      const store = await readStore();
      store.nodeBackups[home] = encodeKeypairBackup(keyJson);
      await writeStore(store);
      await ensureNodePersisted(node);
      adoptedOwners.push(operator);
      listedOwners.add(operator);
      base.adopted.push(node.moniker);
      log.info('reconnect server: node recovered', { host, id: home, operator, pda: chain.address, running });
    } catch (err) {
      base.skipped.push({ home, reason: `could not read this node: ${(err as Error).message}` });
      log.warn('reconnect server: node home unreadable', { host, home, err: (err as Error).message });
    } finally {
      await rt?.close();
    }
  }

  await forgetDiscovered(adoptedOwners);
  if (base.adopted.length) {
    await addEvent({
      kind: 'nodes-recovered',
      title: `Recovered ${base.adopted.length} node${base.adopted.length === 1 ? '' : 's'} from ${host}`,
      subtitle: base.adopted.join(', ').slice(0, 200),
    });
  }
  broadcast(IPC.NODES_CHANGED, null);

  const total = base.adopted.length + base.alreadyListed.length;
  const outcome: HostOutcome = total > 0 ? 'reconnected' : 'no-node-found';
  const message =
    outcome === 'reconnected'
      ? `${total} node${total === 1 ? '' : 's'} under control${base.adopted.length ? ` (${base.adopted.length} recovered)` : ''}`
      : 'Logged in, but this server runs no node of yours.';
  return { ...base, outcome, message };
}

export interface RecoveryServer {
  host: string;
  port: number;
  /** Nodes the list already has here that still wait for a login. */
  listedWaiting: number;
  /** Nodes found from the wallet that advertise this host. */
  discovered: number;
  /** True once a login for this host is attached (nothing to do). */
  connected: boolean;
}

/**
 * Servers the Reconnect window offers: every server this app ever logged in to (known-hosts.json),
 * plus hosts advertised by nodes found from the wallet and hosts of listed nodes without a login.
 */
export async function recoveryServers(): Promise<RecoveryServer[]> {
  const { listKnownHosts } = await import('./host-keys');
  const { getSSH } = await import('./node-manager');
  const byHost = new Map<string, RecoveryServer>();
  const add = (host: string, port = 22) => {
    const k = host.toLowerCase();
    const cur = byHost.get(k) ?? { host, port, listedWaiting: 0, discovered: 0, connected: false };
    byHost.set(k, cur);
    return cur;
  };
  for (const h of await listKnownHosts()) add(h.host, h.port);
  const store = await readStore();
  const listedOwners = new Set(store.nodes.map((n) => n.operatorAddress));
  for (const d of store.discoveredNodes ?? []) {
    if (d.noNodeOnChain || listedOwners.has(d.operatorAddress) || !d.host) continue;
    add(d.host).discovered += 1;
  }
  for (const n of store.nodes) {
    if (n.target !== 'remote' || !n.host) continue;
    const s = add(n.host, n.sshPort ?? 22);
    if (getSSH(n.id)) s.connected = true;
    else s.listedWaiting += 1;
  }
  return [...byHost.values()].sort((a, b) => Number(a.connected) - Number(b.connected) || b.discovered - a.discovered || a.host.localeCompare(b.host));
}

let discovering: Promise<unknown> | null = null;

/** Run "Find my nodes" once at a time; used at start-up (empty list) and after a wallet import. */
export function autoDiscover(reason: string): void {
  if (discovering) return;
  log.info('find my nodes: automatic scan', { reason });
  discovering = import('./node-manager')
    .then(({ discoverNodes }) => discoverNodes())
    .then(() => broadcast(IPC.NODES_CHANGED, null))
    .catch((err: unknown) => log.warn('find my nodes: automatic scan failed', { reason, err: (err as Error).message }))
    .finally(() => (discovering = null));
}
