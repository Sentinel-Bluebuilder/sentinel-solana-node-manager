import { BrowserWindow, safeStorage } from 'electron';
import crypto from 'node:crypto';
import os from 'node:os';
import { PublicKey, type Keypair } from '@solana/web3.js';
import {
  NODE_BOND_BASE,
  PORT_BLOCK_SIZE,
  PROTOCOLS,
  baseToDisplay,
  displayToBase,
  explorerTx,
  protocolInfo,
} from './chain';
import { CTL_HOME, NODE_HOME, dockerHealth, resolveImageTag } from './docker';
import { PREBUILT_IMAGE_TAG } from './prebuilt-image';
import { pickRPC } from './solana-client';
import { getSettings } from './settings';
import { readStore, writeStore } from './store';
import { addEvent } from './events';
import { appKeypair, fetchBalances, generateNodeKey, sendFrom, tokenAccount } from './wallet';
import { keypairToJson } from './keys';
import { ensureNodePersisted, rememberSSH, removeNode, updateNode, getNode, beginRemoval, markDeploying, portsToClose } from './node-manager';
import { openRuntime, isRemoteRuntime, type NodeRuntime } from './node-runtime';
import { blockPorts, patchNodeConfig, patchTopConfig, pinServicePorts } from './node-config';
import { cliLayoutOf, ctlConfigToml, nodePda, openNode, programParams, showNode } from './dvpnctl';
import { binariesFor, homePathsFor, translateArgs } from './cli-layout';
import { failedDeployVerdict, isPublicIPv4 } from './validate';
import { captureLocalSpecs, publishNodeSpecs } from './node-specs';
import { resolveCountry, resolveOwnCountry, resolveOwnPublicIp } from './geoip';
import { log } from './logger';
import { hnsdNotRunningMessage, waitForHnsd } from './hnsd';
import { IPC, type DeployPhase, type DeployProgress, type DeployRequest, type DeployedNode, type SSHCredentials } from '../../shared/types';

/**
 * Deploy orchestration — Sentinel dVPN node on the Solana program (devnet).
 *
 * One sequence for local (Docker Desktop) and remote (SSH + Docker) targets,
 * through NodeRuntime:
 *   1. preflight   app wallet holds ≥ SEED_SOL + fees and ≥ 1 tDVPN bond;
 *                  port block P..P+4 free; Docker reachable (remote: installed)
 *   2. image       build node-manager/dvpnd:devnet if missing
 *   3. fund        one tx: SOL + 1 tDVPN app wallet → node key (ATA created)
 *   4. init        `dvpnd init --role node` → node id, TLS pin; node key written
 *                  over the generated key (the node key IS the on-chain owner)
 *   5. configure   pin every protocol's public port into the block, strip
 *                  REALITY, RPC + redeem threshold, dvpnctl home
 *   6. open        `dvpnctl node open-node` (bond 1 tDVPN) signed by the node key
 *   7. start       container with the whole block published tcp+udp
 *   8. verify      daemon lists itself (Node.status = 1, fresh listedAt)
 * A failure after funding reclaims the funds (or, after open_node, starts
 * the resumable removal), so nothing is ever stranded.
 */

/** SOL sent to each node key: rent (node ≈0.0032, ATA ≈0.002) + fees for ~a year of hourly heartbeats. */
const NODE_SEED_SOL = 0.05;
/** Headroom the app wallet must keep for the funding tx itself. */
const DEPLOY_SOL_BUFFER = 0.01;
const VERIFY_TIMEOUT_MS = 180_000;

type ProgressFn = (p: DeployProgress) => void;
/** Every deploy frame also reaches the renderer, whichever entry (IPC, CLI) started the job. */
function broadcastProgress(p: DeployProgress): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.DEPLOY_PROGRESS, p);
}
type PushFn = (phase: DeployPhase, percent: number, message: string, log: string, extras?: Partial<DeployProgress>) => void;

interface RunningJob {
  jobId: string;
  cancel: () => void;
  abort: AbortController;
  onProgress: ProgressFn;
  lockKey: string;
}

const jobs = new Map<string, RunningJob>();
// Last DeployProgress per job, kept so CLI clients can poll `deploy.status`.
const lastProgress = new Map<string, DeployProgress>();
const TERMINAL_PHASES = new Set<DeployProgress['phase']>(['done', 'error', 'cancelled']);

export function getDeployProgress(jobId: string): DeployProgress | null {
  return lastProgress.get(jobId) ?? null;
}

export function listDeployProgress(): DeployProgress[] {
  return Array.from(lastProgress.values());
}

/** Kept for the startup hook; settings are read live now. */
export async function primeDeploySettings(): Promise<void> {
  await getSettings();
}

/** First non-internal IPv4 that is not a virtual adapter — the host clients dial for a local node. */
export function defaultLocalHost(): string {
  const ifaces = os.networkInterfaces();
  const candidates: string[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (/vEthernet|WSL|docker|Hyper-V|VirtualBox|VMware|Loopback|tailscale|ZeroTier/i.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) candidates.push(a.address);
    }
  }
  return candidates[0] ?? '127.0.0.1';
}

export async function startDeploy(req: DeployRequest, onProgress: ProgressFn): Promise<{ jobId: string; nodeId: string }> {
  const jobId = crypto.randomUUID();
  const nodeId = crypto.randomUUID();

  const lockKey = req.target === 'remote' ? `remote:${req.ssh?.host ?? ''}` : 'local';
  for (const j of jobs.values()) {
    if (j.lockKey === lockKey) {
      throw new Error(
        req.target === 'remote'
          ? `A node is already being deployed to ${req.ssh?.host}. Please wait for it to finish, or cancel it from the bar at the top of the window.`
          : 'A node is already being deployed on this computer. Please wait for it to finish, or cancel it from the bar at the top of the window.',
      );
    }
  }

  const store = await readStore();
  if (!store.wallet?.address) {
    throw new Error('You need a wallet first. Create, restore or import a wallet before deploying a node.');
  }
  protocolInfo(req.serviceType); // throws on an unknown protocol
  if (req.target === 'remote' && !req.ssh?.host?.trim()) throw new Error('SSH credentials (with a host) are required for a remote deploy.');
  if (!req.moniker?.trim()) throw new Error('A moniker (node name) is required.');
  const prices = basePrices(req); // throws on zero / NaN before anything is spent
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('This computer cannot encrypt the node key backup (no OS keychain). Deploy cancelled before any funds moved.');
  }

  if (!Number.isInteger(req.port) || req.port < 1024 || req.port + PORT_BLOCK_SIZE - 1 > 65535) {
    throw new Error(`The port must be a whole number between 1024 and ${65535 - PORT_BLOCK_SIZE + 1}. The node uses ${PORT_BLOCK_SIZE} ports starting there.`);
  }
  const MAX_LOCAL_NODES = 3;
  // Nodes being removed whose container is already gone (stage past 'stop')
  // no longer occupy the host: they hold neither a slot nor their port block.
  const occupiesHost = (n: DeployedNode) => !n.removalStage || n.removalStage === 'redeem' || n.removalStage === 'stop';
  const sameHost = store.nodes.filter(
    (n) =>
      occupiesHost(n) &&
      (req.target === 'local' ? n.target === 'local' : n.target === 'remote' && n.host === req.ssh?.host),
  );
  if (req.target === 'local' && sameHost.length >= MAX_LOCAL_NODES) {
    throw new Error(`This computer already has ${sameHost.length} nodes, which is the maximum (${MAX_LOCAL_NODES}). Remove one first.`);
  }
  const overlap = sameHost.find((n) => Math.abs(n.port - req.port) < PORT_BLOCK_SIZE);
  if (overlap) {
    throw new Error(
      `Ports ${req.port}–${req.port + PORT_BLOCK_SIZE - 1} overlap node "${overlap.moniker}" (${overlap.port}–${overlap.port + PORT_BLOCK_SIZE - 1}). Pick a port at least ${PORT_BLOCK_SIZE} away.`,
    );
  }

  // Balance preflight — fail before any work if the wallet cannot fund the node.
  const needSol = NODE_SEED_SOL + DEPLOY_SOL_BUFFER;
  const needDvpn = baseToDisplay(NODE_BOND_BASE);
  let bal;
  try {
    bal = await fetchBalances(store.wallet.address);
  } catch (err) {
    throw new Error(`Could not check your wallet balance before deploying. Check your connection and try again. Details: ${(err as Error).message}`);
  }
  if (bal.sol < needSol || bal.dvpn < needDvpn) {
    throw new Error(
      `Your wallet needs at least ${Number(needSol.toFixed(9))} SOL and ${needDvpn} tDVPN to start a node ` +
        `(${needDvpn} tDVPN is the node's bond, returned when you remove it; ${NODE_SEED_SOL} SOL pays its rent and fees). ` +
        `You have ${bal.sol.toFixed(4)} SOL and ${bal.dvpn.toFixed(6)} tDVPN.`,
    );
  }

  const { mnemonic: nodeMnemonic, address: operatorAddress, keypair: nodeKp } = await generateNodeKey();
  // The address clients dial: an explicit public host/DNS wins (a VPS behind a
  // load balancer or with a DNS name), else the SSH host, else this machine's public IP.
  const explicitHost = stripToHost(req.remoteUrl ?? '');
  // The host is written into TOML and into the on-chain URI: hostnames / IP literals only.
  if (explicitHost && !/^[A-Za-z0-9.\-]{1,253}$|^[0-9a-fA-F:]{2,39}$/.test(explicitHost)) {
    throw new Error(`"${req.remoteUrl}" is not a host name or IP address.`);
  }
  // Local: the public IP, because clients refuse a node whose address is not public. The LAN
  // IP is only a last resort (no lookup answered) and is logged as unreachable from outside.
  let host = explicitHost || (req.target === 'remote' ? req.ssh!.host : '');
  if (!host) {
    const lan = defaultLocalHost();
    host = isPublicIPv4(lan) ? lan : (await resolveOwnPublicIp()) ?? lan;
    if (!isPublicIPv4(host)) log.warn('local deploy: no public IP found; clients will refuse this node until --host is set', { host });
  }

  const node: DeployedNode = {
    id: nodeId,
    name: req.moniker,
    moniker: req.moniker,
    target: req.target,
    host: req.ssh?.host,
    sshPort: req.ssh?.port,
    sshUser: req.ssh?.username,
    status: 'loading',
    region: req.target === 'remote' ? req.ssh?.host ?? 'Remote' : 'This device',
    createdAt: new Date().toISOString(),
    operatorAddress,
    balanceDVPN: 0,
    balanceSOL: 0,
    port: req.port,
    gigabytePriceDVPN: req.gigabytePriceDVPN,
    hourlyPriceDVPN: req.hourlyPriceDVPN,
    leaseHourlyPriceDVPN: req.leaseHourlyPriceDVPN ?? req.hourlyPriceDVPN,
    priceMode: 'flat',
    serviceType: req.serviceType,
    registeredOnChain: false,
    remoteUrl: stripToHost(host),
    handshakeDns: req.handshakeDns === true,
  };
  await ensureNodePersisted(node);
  markDeploying(nodeId, true);

  // Encrypted backup of the node phrase so withdrawals / removal work without SSH.
  {
    const s = await readStore();
    s.nodeBackups[nodeId] = safeStorage.encryptString(nodeMnemonic).toString('base64');
    await writeStore(s);
  }
  if (req.target === 'remote' && req.ssh) rememberSSH(nodeId, req.ssh);

  await addEvent({
    kind: 'deploy-started',
    title: `Deploying ${req.moniker}`,
    subtitle: req.target === 'remote' ? `Remote · ${req.ssh?.host}` : 'Local device',
    relatedNodeId: nodeId,
  });

  let cancelled = false;
  const abort = new AbortController();
  jobs.set(jobId, {
    jobId,
    cancel: () => {
      cancelled = true;
      abort.abort();
    },
    abort,
    onProgress,
    lockKey,
  });

  // The phrase rides only the first non-error frame (modal opens at once) and
  // the terminal 'done' frame — never every frame.
  let mnemonicEmitted = false;
  const push: PushFn = (phase, percent, message, logLine, extras = {}) => {
    if (cancelled && phase !== 'error') return;
    const carry = phase !== 'error' && phase !== 'cancelled' && (!mnemonicEmitted || phase === 'done');
    if (carry) mnemonicEmitted = true;
    const progress: DeployProgress = {
      jobId,
      nodeId,
      phase,
      percent,
      message,
      log: scrubLog(logLine),
      ...(carry ? { mnemonicForBackup: nodeMnemonic, operatorAddress } : {}),
      ...extras,
    };
    lastProgress.set(jobId, progress);
    if (TERMINAL_PHASES.has(phase)) setTimeout(() => lastProgress.delete(jobId), 60_000).unref?.();
    broadcastProgress(progress);
    onProgress(progress);
  };

  void (async () => {
    let stage: 'pre-fund' | 'funded' | 'opened' = 'pre-fund';
    try {
      stage = await runDeploy(req, node, nodeKp, host, prices, push, () => cancelled, abort.signal, (s) => (stage = s));
      if (cancelled) throw new Error('cancelled');
      push('done', 100, 'Node is online', `[${ts()}] ${node.moniker} is listed on Solana devnet (${req.serviceType}).`);
      await addEvent({
        kind: 'deploy-succeeded',
        title: `Node ${node.moniker} is online`,
        subtitle: req.target === 'remote' ? `Remote · ${req.ssh?.host}` : 'Local device',
        relatedNodeId: nodeId,
      });
      await addEvent({ kind: 'node-started', title: `Node ${node.moniker} started`, subtitle: node.region ?? '', relatedNodeId: nodeId });
      void publishNodeSpecs(nodeId, { force: true })
        .then((r) => (r.ok ? push('done', 100, 'Node is online', `[${ts()}] Specs memo published · ${r.txHash}`) : log.warn('specs publish skipped', { nodeId, err: r.error })))
        .catch((err: unknown) => log.warn('specs publish threw', { nodeId, err: (err as Error).message }));
    } catch (err) {
      const msg = cancelled ? 'Deploy cancelled.' : ((err as Error).message ?? 'Unknown error');
      log.error('deploy failed', { id: nodeId, stage, err: msg });
      if (!cancelled) push('error', 0, 'Deployment failed', `[${ts()}] ${msg}`);
      await addEvent({ kind: 'deploy-failed', title: `Deployment failed: ${node.moniker}`, subtitle: msg.slice(0, 180), relatedNodeId: nodeId });
      await recoverFailedDeploy(nodeId, stage, req.ssh).catch((rerr: unknown) =>
        log.error('failed-deploy recovery errored — node kept for manual removal', { nodeId, err: (rerr as Error).message }),
      );
    } finally {
      jobs.delete(jobId);
      markDeploying(nodeId, false);
    }
  })();

  return { jobId, nodeId };
}

/**
 * Nothing may be stranded by a failed deploy:
 *   pre-fund → drop the node record;
 *   funded   → sweep the node key's SOL + tDVPN back to the app wallet, drop the record;
 *   opened   → the node exists on chain with a bond: start the normal
 *              (resumable) removal, which delists, closes, unbonds and sweeps.
 */
async function recoverFailedDeploy(nodeId: string, stage: 'pre-fund' | 'funded' | 'opened', creds?: SSHCredentials): Promise<void> {
  markDeploying(nodeId, false);
  const node = await getNode(nodeId);
  if (!node) return;
  const mgr = await import('./node-manager');
  if (stage === 'funded' && node.nodePda) {
    // open_node may have LANDED even though dvpnctl did not return (cancelled or
    // timed out mid-confirm). The chain decides, not the stage variable, read over
    // plain RPC: dvpnctl runs on local Docker, where a remote node's image is absent.
    const verdict = failedDeployVerdict(await mgr.nodeAccountState(node.nodePda));
    if (verdict === 'keep') {
      await updateNode(nodeId, { status: 'error' });
      throw new Error('could not read the chain to tell whether the node was opened; the record and node key are kept — remove the node later to reclaim the funds');
    }
    if (verdict === 'opened') stage = 'opened';
  }
  if (stage === 'opened') {
    await updateNode(nodeId, { registeredOnChain: true });
    await beginRemoval(nodeId); // resumable: delist → close → unbond → withdraw → sweep
    return;
  }
  await removeContainerAndHome(node, creds).catch(async (err: unknown) => {
    log.warn('failed-deploy container cleanup failed', { nodeId, err: (err as Error).message });
    // The record may be dropped below; the event is the user's only trace of a leftover (fix F).
    await addEvent({
      kind: 'deploy-failed',
      title: `Cleanup after the failed deploy of ${node.moniker} did not finish`,
      subtitle: `${node.target === 'remote' ? `On ${node.host}: ` : ''}${(err as Error).message}`.slice(0, 180),
      relatedNodeId: nodeId,
    });
  });
  if (stage === 'funded') {
    await mgr.sweepNodeKey(nodeId);
    const bal = await fetchBalances(node.operatorAddress);
    if (bal.dvpnBase > 0n || bal.hasTokenAccount || bal.lamports > 10_000) {
      // Keep the record (and its key backup) so the funds stay reachable; the user
      // can remove the node later, which sweeps again.
      await updateNode(nodeId, { status: 'error' });
      throw new Error(`node key still holds ${bal.lamports} lamports / ${bal.dvpn} tDVPN after the sweep; record kept`);
    }
  }
  await removeNode(nodeId, { forget: true });
}

async function removeContainerAndHome(node: DeployedNode, creds?: SSHCredentials): Promise<void> {
  const rt = await openRuntime(node, creds);
  try {
    await rt.removeContainer();
    if (node.firewallOpened) await rt.closePorts(await portsToClose(node, [...Array(PORT_BLOCK_SIZE)].map((_, i) => node.port + i))).catch((err: unknown) => log.warn('firewall rule removal skipped', { id: node.id, err: (err as Error).message }));
    await rt.removeHome();
  } finally {
    await rt.close();
  }
}

async function runDeploy(
  req: DeployRequest,
  node: DeployedNode,
  nodeKp: Keypair,
  host: string,
  prices: { perGb: number; perHour: number; leasePerHour: number },
  push: PushFn,
  isCancelled: () => boolean,
  signal: AbortSignal,
  setStage: (s: 'pre-fund' | 'funded' | 'opened') => void,
): Promise<'opened'> {
  const cancelCheck = () => {
    if (isCancelled()) throw new Error('cancelled');
  };
  const ports = blockPorts(req.port, PORT_BLOCK_SIZE);
  const allPorts = [ports.api, ...ports.service];

  // ── 1. preflight ──
  if (req.target === 'local') {
    push('docker-check', 4, 'Checking Docker', `[${ts()}] Checking that Docker is running…`);
    const health = await dockerHealth();
    if (!health.reachable) {
      throw new Error(`Docker is not running. Open Docker Desktop, wait for it to start, then try again. Details: ${health.error}.`);
    }
    push('docker-check', 6, 'Docker is running', `[${ts()}] Docker ${health.version}`);
    captureLocalSpecs()
      .then((specs) => updateNode(node.id, { specs }))
      .catch((err: unknown) => log.warn('local spec capture failed', { id: node.id, err: (err as Error).message }));
  } else {
    push('connecting', 4, 'Opening secure shell', `[${ts()}] ${req.ssh!.host}:${req.ssh!.port}`);
  }

  const rt = await openRuntime(node, req.ssh);
  try {
    if (isRemoteRuntime(rt)) {
      push('preflight', 8, 'Checking remote host', `[${ts()}] ${rt.label} · node home ${rt.homeOnHost}`);
      await rt.ensureDocker((l) => push('preflight', 10, 'Installing Docker', l));
    }
    const busy = await rt.busyPorts(allPorts);
    if (busy.length) {
      throw new Error(`Port(s) ${busy.join(', ')} are already in use on ${rt.label}. Pick another starting port (the node uses ${allPorts[0]}–${allPorts[allPorts.length - 1]}).`);
    }
    const fw = await rt.openPorts(allPorts);
    if (fw.opened) await updateNode(node.id, { firewallOpened: true });
    push('preflight', 11, 'Host firewall', `[${ts()}] ${fw.detail}`);
    cancelCheck();

    // ── 2. image ──
    // The tag covers the source tree too, so a newer Settings.upstreamDir builds a
    // new image instead of reusing one with an older dvpnd under the same name.
    rt.imageTag = await resolveImageTag();
    await updateNode(node.id, { imageTag: rt.imageTag });
    if (await rt.imageReady()) {
      push('image-build', 30, 'Node image ready', `[${ts()}] ${rt.imageTag} present on ${rt.label}`);
    } else if (rt.imageTag === PREBUILT_IMAGE_TAG) {
      push('image-build', 12, 'Downloading node image', `[${ts()}] ${rt.imageTag}: one-time download, checksum-checked (a few minutes)`);
      await rt.buildImage((line) => push('image-build', 20, 'Downloading node image', line), signal);
      push('image-build', 30, 'Node image ready', `[${ts()}] image ready`);
    } else {
      push('image-build', 12, 'Building node image', `[${ts()}] ${rt.imageTag}: compiles dvpnd + dvpnctl + protocol binaries (10–20 min)`);
      await rt.buildImage((line) => push('image-build', 20, 'Building node image', line), signal);
      push('image-build', 30, 'Node image built', `[${ts()}] image ready`);
    }
    // Say which daemon this node will run, so a wrong build shows up in the log.
    const layout = await cliLayoutOf(rt, signal);
    const bins = binariesFor(layout);
    const paths = homePathsFor(layout);
    const ver = await rt.runOnce([bins.daemon], ['version'], { timeoutMs: 60_000, signal });
    const verLine = ver.output.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
    push('image-build', 31, 'Node image ready', `[${ts()}] ${bins.daemon} version: ${ver.exitCode === 0 && verLine ? verLine : `unknown (exit ${ver.exitCode})`}`);
    cancelCheck();

    // ── 3. program parameters, then fund ──
    // Params and the pause mask are read BEFORE any money moves: a paused program
    // or a raised minimum bond must fail here, not after the funding transaction.
    await rt.prepare();
    const rpcUrl = await pickRPC({ forRemoteHost: isRemoteRuntime(rt) });
    await rt.writeFile('ctl/config.toml', ctlConfigToml(rpcUrl), 0o600);
    const params = await programParams(rt, { signal });
    if (params.paused) {
      throw new Error(`The dvpn program is paused (mask ${params.paused}); node instructions are blocked by the program authority. Nothing was funded or opened.`);
    }
    const bondBase = Math.max(NODE_BOND_BASE, params.minNodeBond);
    const owner = nodeKp.publicKey.toBase58();
    const walletNow = await fetchBalances((await appKeypair()).publicKey.toBase58());
    if (walletNow.dvpnBase < BigInt(bondBase)) {
      throw new Error(`The node bond is ${baseToDisplay(bondBase)} tDVPN but the wallet holds ${walletNow.dvpn} tDVPN. Nothing was funded.`);
    }
    push('fund', 34, 'Funding the node key', `[${ts()}] ${NODE_SEED_SOL} SOL + ${baseToDisplay(bondBase)} tDVPN → ${owner}`);
    const app = await appKeypair();
    const fund = await sendFrom(app, owner, baseToDisplay(bondBase), NODE_SEED_SOL, `fund node ${node.moniker}`.slice(0, 60), {
      title: `Funded node key for ${node.moniker}`,
      subtitle: `${baseToDisplay(bondBase)} tDVPN bond + ${NODE_SEED_SOL} SOL (returned at removal)`,
      amountDVPN: -baseToDisplay(bondBase),
      relatedNodeId: node.id,
    });
    setStage('funded');
    push('fund', 40, 'Node key funded', `[${ts()}] tx ${fund.txHash} · ${explorerTx(fund.txHash!)}`, { txSig: fund.txHash });
    cancelCheck();

    // ── 4. init ──
    const country = await pickCountry(req, host);
    push('keygen', 46, 'Initializing node', `[${ts()}] ${bins.daemon} init · ${req.serviceType} · ${country}`);
    // Older flag names; translateArgs rewrites them for a newer or cb33 daemon (cli-layout.ts).
    const init = await rt.runOnce(
      [bins.daemon],
      translateArgs('dvpnd', [
        'init', '--role', 'node', '--home', NODE_HOME, '--force',
        '--owner', owner,
        '--country', country,
        '--api-addrs', host,
        '--api-port', String(ports.api),
        '--prices.channel-price-per-gb', String(prices.perGb),
        '--prices.channel-price-per-hour', String(prices.perHour),
        '--prices.lease-price-per-hour', String(prices.leasePerHour),
        '--service', req.serviceType,
        '--plain-key',
      ], layout),
      { timeoutMs: 120_000, signal, onLog: (l) => push('keygen', 50, 'Initializing node', l) },
    );
    if (init.exitCode !== 0) throw new Error(`Setting up the node failed: ${init.output.trim().slice(-500)}`);
    const initJson = parseInitJson(init.output);
    // The node id (and so the PDA) is known from here on. Persist it BEFORE
    // open_node so a crash or cancel mid-open can still find the account.
    const pda = nodePda(owner, initJson.id);
    await updateNode(node.id, { chainNodeId: initJson.id, nodePda: pda, tlsSha256: initJson.tls_sha256, country, countryName: country === pickedGeo?.country ? pickedGeo?.countryName : undefined });
    cancelCheck();

    // Node key over the generated key → the daemon signs as the on-chain owner.
    // cb33 calls the generated key the operator key; an operator equal to the owner
    // needs no grant (sentinel-go-sdk auth.Authorize / program.GrantAddress).
    const keyJson = keypairToJson(nodeKp);
    await rt.writeFile(`${paths.keysDir}/${initJson.key}.json`, keyJson, 0o600);
    await rt.writeFile('ctl/keys/owner.json', keyJson, 0o600);

    // ── 5. configure ──
    push('configure', 56, 'Configuring all six protocols', `[${ts()}] ports ${allPorts.join(', ')} · REALITY inbounds stripped`);
    for (const p of PROTOCOLS) {
      const rel = paths.serviceConfig(p.type);
      const pinned = pinServicePorts(p.type, await rt.readFile(rel), ports.service);
      await rt.writeFile(rel, pinned.toml, 0o600);
    }
    // In cb33 both patches land in the one config.toml; patch it in sequence.
    await rt.writeFile(
      paths.nodeConfig,
      patchNodeConfig(await rt.readFile(paths.nodeConfig), {
        redeemThreshold: 1,
        apiPort: ports.api,
        apiAddrs: [host],
        handshakeDns: req.handshakeDns === true,
      }),
      0o600,
    );
    await rt.writeFile(paths.topConfig, patchTopConfig(await rt.readFile(paths.topConfig), rpcUrl), 0o600);
    cancelCheck();

    // ── 6. open on chain ──
    const uri = `https://${host}:${ports.api}`;
    push('configure', 64, 'Opening the node on chain', `[${ts()}] open_node · bond ${baseToDisplay(params.minNodeBond)} tDVPN · ${uri}`);
    const openSig = await openNode(
      rt,
      {
        nodeIdHex: initJson.id,
        owner,
        ownerToken: tokenAccount(new PublicKey(owner)).toBase58(),
        vault: params.vault,
        bondBase,
        country,
        protocols: protocolInfo(req.serviceType).bit,
        uri,
        prices,
      },
      { signal },
    );
    setStage('opened');
    await updateNode(node.id, { registeredOnChain: true, openTx: openSig });
    push('configure', 74, 'Node opened on chain', `[${ts()}] open_node ${openSig} · node ${pda}`, { txSig: openSig });
    cancelCheck();

    // ── 7. start ──
    push('starting', 80, 'Starting node daemon', `[${ts()}] docker run ${allPorts.map((p) => `${p}/tcp+udp`).join(' ')}`);
    const runtimeId = await rt.startContainer(allPorts);
    await updateNode(node.id, { runtimeId, startedAt: new Date().toISOString() });

    // ── 8. verify: daemon running, node listed with a fresh listedAt ──
    push('verifying', 86, 'Waiting for the node to list itself', `[${ts()}] polling ${pda}`);
    const openedAtSec = Math.floor(Date.now() / 1000) - 120;
    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    let listed = false;
    while (Date.now() < deadline) {
      cancelCheck();
      if (!(await rt.isRunning())) {
        const tail = (await rt.logs(60)).join('\n');
        throw new Error(`The node daemon exited during start-up. Last logs:\n${tail.slice(-1500) || '(no output)'}`);
      }
      const chain = await showNode(rt, pda).catch((err: unknown) => {
        log.debug('verify showNode failed', { err: (err as Error).message });
        return null;
      });
      if (chain && chain.status === 1 && chain.listedAt >= openedAtSec) {
        listed = true;
        push('verifying', 97, 'Node is listed', `[${ts()}] listed at ${new Date(chain.listedAt * 1000).toISOString()} · ${chain.uri}`);
        break;
      }
      const lastLog = (await rt.logs(1))[0];
      if (lastLog) push('verifying', 90, 'Waiting for the node to list itself', lastLog);
      await new Promise((r) => setTimeout(r, 8_000));
    }
    if (!listed) {
      const tail = (await rt.logs(40)).join('\n');
      throw new Error(`The node started but did not list itself within ${VERIFY_TIMEOUT_MS / 1000}s. Last logs:\n${tail.slice(-1500)}`);
    }

    // ── 9. HNS resolver: the daemon starts hnsd itself; prove it is running ──
    // Not fatal: the node is open, bonded and listed, and failing the deploy now would
    // send it through removal. The record keeps the reason and the node page shows it.
    if (req.handshakeDns) {
      push('verifying', 98, 'Checking the HNS resolver', `[${ts()}] waiting for hnsd in the node container`);
      if (await waitForHnsd(rt, true)) {
        await updateNode(node.id, { hnsdError: undefined });
        push('verifying', 99, 'HNS resolver running', `[${ts()}] hnsd is running (127.0.0.1:5350 in the node container)`);
      } else {
        const why = hnsdNotRunningMessage(await rt.logs(200));
        await updateNode(node.id, { hnsdError: why });
        log.warn('deploy: hnsd not running', { id: node.id });
        push('verifying', 99, 'HNS resolver did not start', `[${ts()}] ${why}`);
      }
    }
    await updateNode(node.id, { status: 'online' });
    return 'opened';
  } finally {
    await rt.close();
  }
}

function basePrices(req: Pick<DeployRequest, 'gigabytePriceDVPN' | 'hourlyPriceDVPN' | 'leaseHourlyPriceDVPN'>): {
  perGb: number;
  perHour: number;
  leasePerHour: number;
} {
  const perGb = Number(displayToBase(req.gigabytePriceDVPN));
  const perHour = Number(displayToBase(req.hourlyPriceDVPN));
  const leasePerHour = Number(displayToBase(req.leaseHourlyPriceDVPN ?? req.hourlyPriceDVPN));
  if (![perGb, perHour, leasePerHour].every((p) => Number.isFinite(p) && p > 0)) {
    throw new Error('All three prices must be numbers greater than 0 (the program rejects a zero price).');
  }
  return { perGb, perHour, leasePerHour };
}

let pickedGeo: { country: string; countryName: string } | undefined;
async function pickCountry(req: DeployRequest, host: string): Promise<string> {
  pickedGeo = undefined;
  if (req.country && /^[A-Za-z]{2}$/.test(req.country)) return req.country.toUpperCase();
  const geo = (await resolveCountry(host)) ?? (await resolveOwnCountry());
  pickedGeo = geo;
  return geo?.country ?? 'US';
}

export interface InitJson {
  id: string;
  /** Key file name under node/keys (older dvpnd prints `key`, newer `key_name`). */
  key: string;
  public_key: string;
  api_port: number;
  tls_sha256: string;
}

/** Parse `dvpnd init` JSON output (one line, among log lines). */
export function parseInitJson(output: string): InitJson {
  for (const line of output.split(/\r?\n/).reverse()) {
    const t = line.trim();
    if (!t.startsWith('{') || !t.includes('"role"')) continue;
    const j = JSON.parse(t) as InitJson & { key_name?: string };
    if (!j.key && typeof j.key_name === 'string') j.key = j.key_name;
    if (!/^[0-9a-f]{64}$/.test(j.id) || !j.key || !j.tls_sha256) {
      throw new Error(`dvpnd init output is missing fields: ${t.slice(0, 200)}`);
    }
    return j;
  }
  throw new Error(`dvpnd init printed no result JSON: ${output.trim().slice(-300)}`);
}

export function cancelDeploy(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;
  const onProgress = job.onProgress;
  job.cancel();
  jobs.delete(jobId);
  const prev = lastProgress.get(jobId);
  const cancelled: DeployProgress = prev
    ? { ...prev, phase: 'cancelled', message: 'Cancelled', log: `[${ts()}] Deploy cancelled by user.`, mnemonicForBackup: undefined }
    : { jobId, nodeId: '', phase: 'cancelled', percent: 0, message: 'Cancelled', log: `[${ts()}] Deploy cancelled by user.` };
  lastProgress.set(jobId, cancelled);
  setTimeout(() => lastProgress.delete(jobId), 60_000).unref?.();
  broadcastProgress(cancelled);
  try {
    onProgress(cancelled);
  } catch (e) {
    log.warn('cancel broadcast failed', { jobId, err: String(e) });
  }
  return true;
}

/** Normalize a URL / host:port / [v6]:port to the bare host. */
export function stripToHost(raw: string): string {
  let s = (raw ?? '').trim();
  s = s.replace(/^[a-z]+:\/\//i, '');
  s = s.replace(/\/+$/, '');
  const v6 = s.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (v6) return v6[1];
  const hp = s.match(/^([^:/]+):\d+$/);
  if (hp) return hp[1];
  return s;
}

function ts(): string {
  return new Date().toISOString().split('T')[1]!.replace('Z', '');
}

const ANSI_WITH_ESC = /\x1B\[[0-?]*[ -/]*[@-~]|\x9B[0-?]*[ -/]*[@-~]/g;
const ANSI_WITHOUT_ESC = /\[\d{1,3}(?:;\d{1,3})*m/g;
function scrubLog(s: string | undefined): string {
  if (!s) return '';
  return s
    .replace(ANSI_WITH_ESC, '')
    .replace(ANSI_WITHOUT_ESC, '')
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '')
    .trimEnd();
}

export const _internals = { CTL_HOME, NODE_SEED_SOL };
export type { NodeRuntime };
