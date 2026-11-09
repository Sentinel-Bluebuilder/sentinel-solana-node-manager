/**
 * Main-process CLI command registry — the ONLY registry.
 *
 * The in-app CLI screen, the local pipe / unix socket (PowerShell, AI agent)
 * and the e2e suite all execute through `runCommand` here. The renderer only
 * reads command metadata over IPC (`CLI_COMMANDS`).
 *
 * Every command declares its arguments; `runCommand` rejects a flag that a
 * command does not declare, so a typo (`--dry-run` on a command without one)
 * fails loudly instead of silently running the un-flagged action.
 */

import { safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import QRCode from 'qrcode';
import {
  type AppSettings,
  type DeployProgress,
  type DeployRequest,
  type LocalSystemReport,
  type MetricsWindow,
  type NodeLogExportRequest,
  type NodeLogExportResult,
  type NodeWithdrawRequest,
  type SSHCredentials,
  type SendTxRequest,
  type UpdateNodePricingRequest,
  type VpnServiceType,
} from '../../shared/types';
import { testSSHConnection } from './ssh';
import { validateSSHCredentials, validateHostPort, clampEventLimit, requireNodeId, requireNodeRef } from './validate';
import { writeDiagnosticsZip, renderLogExport } from './diagnostics';
import { isValidMnemonic } from './keys';
import { forgetHostKey } from './host-keys';
import {
  startDeploy,
  cancelDeploy,
  primeDeploySettings,
  getDeployProgress,
  listDeployProgress,
} from './deploy';
import { getUpdaterState, checkForUpdatesNow, installPendingUpdate } from './updater';
import {
  getWallet,
  createWallet,
  restoreWallet,
  refreshWalletBalance,
  sendTokens,
  logoutWallet,
  importKeyFile,
} from './wallet';
import {
  listNodes,
  getNode,
  removeNode,
  restartNode,
  startNode,
  stopNode,
  recentLogs,
  nodeStatus,
  nodeHistory,
  withdrawFromNode,
  updateNodePricing,
  setNodeProtocol,
  redeemNow,
  relistNow,
  withdrawBondNow,
  forgetServerNow,
  testNodeSession,
} from './nodes';
import {
  chainNodeByRef,
  closeNodeSession,
  inspectNodeTrust,
  nodeDaemonInfo,
  nodeLeasesByRef,
  nodePositions,
  nodeRedemptions,
  nodeSession,
  nodeSessions,
  programOverview,
  reconnectHost,
  cleanHostLeftovers,
  unwatchNode,
  watchNode,
  watchedNodes,
} from './node-manager';
import { sweepTestChannels } from './test-channels';
import { PROTOCOLS } from './chain';
import { publishNodeSpecs, readPublishedSpecs } from './node-specs';
import { listEvents } from './events';
import { getSettings, redactSettings, updateSettings } from './settings';
import {
  startDockerDesktop,
  resetDockerClient,
  dockerOverview,
  stopAllSentinelContainers,
  pruneDangling,
  quitDockerDesktop,
  forceQuitDockerDesktop,
} from './docker';
import { buildLocalSystemReport } from './system-report';
import { healthAll, invalidateHealthCache } from './solana-client';
import { readStore, writeStore } from './store';

// ─── argv handling lives in cli-args.ts (pure, unit-tested) ────────────────
import {
  boolFlag,
  checkArgs,
  numberFlag,
  optionalFlag,
  parseArgs,
  readArgFile,
  requireFlag,
  requirePositional,
  tokenize,
  type CliArgSpec,
  type ParsedArgs,
} from './cli-args';
export { parseArgs, tokenize, type ParsedArgs } from './cli-args';

const SERVICE_LIST = PROTOCOLS.map((x) => x.type).join('|');
const isVpnServiceType = (s: string): s is VpnServiceType => PROTOCOLS.some((x) => x.type === s);
const isMetricsWindow = (s: string): s is MetricsWindow =>
  s === '1h' || s === '24h' || s === '7d' || s === '30d';

// ─── helpers needed for main-side execution ──────────────────────────────────

async function reportLocalSystem(): Promise<LocalSystemReport> {
  return buildLocalSystemReport();
}

async function exportDiagnosticsToTmp(): Promise<{ ok: boolean; path?: string; error?: string }> {
  // Headless variant of the GUI export: same bundle (sanitized store, redacted
  // settings, meta, logs), written to the OS temp dir instead of a chosen path.
  const tmpDir = path.join(os.tmpdir(), 'sentinel-dvpn-diagnostics');
  await fs.mkdir(tmpDir, { recursive: true });
  const stamp = new Date().toISOString().split('T')[0];
  const target = path.join(tmpDir, `sentinel-dvpn-diagnostics-${stamp}.zip`);
  try {
    await writeDiagnosticsZip(target);
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function exportNodeLogsHeadless(
  req: NodeLogExportRequest,
): Promise<NodeLogExportResult> {
  const node = await getNode(req.nodeId);
  const moniker = node?.moniker?.replace(/[^A-Za-z0-9_.-]/g, '_') ?? req.nodeId;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const ext = req.format === 'json' ? 'json' : req.format === 'log' ? 'log' : 'txt';
  const tmp = path.join(os.tmpdir(), 'sentinel-dvpn-logs');
  await fs.mkdir(tmp, { recursive: true });
  const target = path.join(tmp, `${moniker}-logs-${stamp}.${ext}`);
  await fs.writeFile(target, renderLogExport(req, node?.moniker ?? null), 'utf8');
  return { ok: true, path: target };
}

// ─── command registry ────────────────────────────────────────────────────────

export type MainCliArg = CliArgSpec;

export interface MainCliCommand {
  name: string;
  group:
    | 'system'
    | 'docker'
    | 'settings'
    | 'wallet'
    | 'events'
    | 'updater'
    | 'ssh'
    | 'deploy'
    | 'nodes'
    | 'cli';
  summary: string;
  usage: string;
  args: MainCliArg[];
  exec: (parsed: ParsedArgs) => Promise<unknown>;
}

export const MAIN_COMMANDS: MainCliCommand[] = [
  // ── system ────────────────────────────────────────────────────────────────
  {
    name: 'system.report',
    group: 'system',
    summary: 'Local system + Docker reachability snapshot.',
    usage: 'system.report',
    args: [],
    exec: () => reportLocalSystem(),
  },
  {
    name: 'system.exportDiagnostics',
    group: 'system',
    summary: 'Bundle store + settings into a zip in the OS temp dir.',
    usage: 'system.exportDiagnostics',
    args: [],
    exec: () => exportDiagnosticsToTmp(),
  },

  // ── docker ────────────────────────────────────────────────────────────────
  {
    name: 'docker.start',
    group: 'docker',
    summary: 'Spawn Docker Desktop (Windows / macOS only).',
    usage: 'docker.start',
    args: [],
    exec: async () => {
      const r = await startDockerDesktop();
      resetDockerClient();
      return r;
    },
  },
  {
    name: 'docker.overview',
    group: 'docker',
    summary: 'Daemon stats: containers, images, sentinel containers/images.',
    usage: 'docker.overview',
    args: [],
    exec: () => dockerOverview(),
  },
  {
    name: 'docker.quit',
    group: 'docker',
    summary: 'Politely quit Docker Desktop.',
    usage: 'docker.quit',
    args: [],
    exec: async () => {
      const r = await quitDockerDesktop();
      resetDockerClient();
      return r;
    },
  },
  {
    name: 'docker.forceQuit',
    group: 'docker',
    summary: 'Force-kill Docker Desktop process tree.',
    usage: 'docker.forceQuit',
    args: [],
    exec: async () => {
      const r = await forceQuitDockerDesktop();
      resetDockerClient();
      return r;
    },
  },
  {
    name: 'docker.stopAllSentinel',
    group: 'docker',
    summary: 'Stop every running Sentinel container managed by this app.',
    usage: 'docker.stopAllSentinel',
    args: [],
    exec: () => stopAllSentinelContainers(),
  },
  {
    name: 'docker.prune',
    group: 'docker',
    summary: 'Prune dangling Docker images.',
    usage: 'docker.prune',
    args: [],
    exec: () => pruneDangling(),
  },

  // ── settings ──────────────────────────────────────────────────────────────
  {
    name: 'settings.get',
    group: 'settings',
    summary: 'Read the persisted app settings (RPC API keys redacted).',
    usage: 'settings.get',
    args: [],
    exec: async () => redactSettings(await getSettings()),
  },
  {
    name: 'settings.set',
    group: 'settings',
    summary: 'Patch one or more settings fields. Pass JSON via --json.',
    usage: 'settings.set --json \'{"minimizeToTrayOnClose":true}\'',
    args: [{ name: 'json', kind: 'flag', required: true, describe: 'JSON object to patch.' }],
    exec: async (p) => {
      const patch = JSON.parse(requireFlag(p, 'json')) as Partial<AppSettings>;
      const next = await updateSettings(patch);
      invalidateHealthCache();
      await primeDeploySettings();
      return redactSettings(next);
    },
  },
  {
    name: 'settings.chainHealth',
    group: 'settings',
    summary: 'Probe every configured Solana RPC (genesis = devnet, slot, latency).',
    usage: 'settings.chainHealth',
    args: [],
    exec: () => healthAll(),
  },

  // ── wallet ────────────────────────────────────────────────────────────────
  {
    name: 'wallet.get',
    group: 'wallet',
    summary: 'Current wallet (address, balance, hasMnemonic).',
    usage: 'wallet.get',
    args: [],
    exec: () => getWallet(),
  },
  {
    name: 'wallet.create',
    group: 'wallet',
    summary: 'Generate a new wallet. Returns the mnemonic ONCE.',
    usage: 'wallet.create',
    args: [],
    exec: () => createWallet(),
  },
  {
    name: 'wallet.restore',
    group: 'wallet',
    summary: 'Restore a wallet from a BIP-39 mnemonic.',
    usage: 'wallet.restore --mnemonic "word1 word2 ... word24"',
    args: [{ name: 'mnemonic', kind: 'flag', required: true, describe: 'BIP-39 mnemonic.' }],
    exec: (p) => restoreWallet(requireFlag(p, 'mnemonic')),
  },
  {
    name: 'wallet.refreshBalance',
    group: 'wallet',
    summary: 'Re-query the chain for the wallet balance.',
    usage: 'wallet.refreshBalance',
    args: [],
    exec: () => refreshWalletBalance(),
  },
  {
    name: 'wallet.send',
    group: 'wallet',
    summary: 'Send tDVPN and/or SOL from the app wallet (one transaction).',
    usage: 'wallet.send --to <base58> --amount 1.5 [--sol 0.01] [--memo "hello"]',
    args: [
      { name: 'to', kind: 'flag', required: true, describe: 'Recipient Solana address.' },
      { name: 'amount', kind: 'flag', required: true, describe: 'tDVPN amount (0 allowed with --sol).' },
      { name: 'sol', kind: 'flag', describe: 'SOL to send in the same transaction.' },
      { name: 'memo', kind: 'flag', describe: 'Optional memo.' },
    ],
    exec: (p) => {
      const req: SendTxRequest = {
        to: requireFlag(p, 'to'),
        amountDVPN: numberFlag(p, 'amount', true) as number,
        amountSOL: numberFlag(p, 'sol'),
        memo: optionalFlag(p, 'memo'),
      };
      return sendTokens(req);
    },
  },
  {
    name: 'wallet.qrSvg',
    group: 'wallet',
    summary: 'Render an SVG QR code for any text.',
    usage: 'wallet.qrSvg --text <address>',
    args: [{ name: 'text', kind: 'flag', required: true, describe: 'String to encode.' }],
    exec: (p) =>
      QRCode.toString(requireFlag(p, 'text'), {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 1,
        color: { dark: '#0B1020', light: '#FFFFFF' },
      }),
  },
  {
    name: 'wallet.importKey',
    group: 'wallet',
    summary: 'Import a solana-keygen key file (64-byte JSON) as the app wallet.',
    usage: 'wallet.importKey --file <path-to-key.json>',
    args: [{ name: 'file', kind: 'flag', required: true, describe: 'Path to the key file.' }],
    exec: async (p) => importKeyFile(await readArgFile('file', requireFlag(p, 'file'))),
  },
  {
    name: 'wallet.logout',
    group: 'wallet',
    summary: 'Wipe the app wallet from disk. (Destructive.)',
    usage: 'wallet.logout',
    args: [],
    exec: () => logoutWallet(),
  },

  // ── events ────────────────────────────────────────────────────────────────
  {
    name: 'events.list',
    group: 'events',
    summary: 'Most recent app events.',
    usage: 'events.list [--limit 50]',
    args: [{ name: 'limit', kind: 'flag', describe: 'Max events.' }],
    exec: (p) => Promise.resolve(listEvents(clampEventLimit(numberFlag(p, 'limit')))),
  },

  // ── ssh ───────────────────────────────────────────────────────────────────
  {
    name: 'ssh.test',
    group: 'ssh',
    summary: 'Probe SSH credentials.',
    usage:
      'ssh.test --host 1.2.3.4 --port 22 --username root [--password ...] [--privateKey ...]',
    args: [
      { name: 'host', kind: 'flag', required: true, describe: 'IP or hostname.' },
      { name: 'port', kind: 'flag', describe: 'SSH port (default 22).' },
      { name: 'username', kind: 'flag', required: true, describe: 'SSH user.' },
      { name: 'password', kind: 'flag', describe: 'Password.' },
      { name: 'privateKey', kind: 'flag', describe: 'PEM key contents (single line only — prefer --key-file).' },
      { name: 'key-file', kind: 'flag', describe: 'Path to a private key file; read by the app, never echoed.' },
      { name: 'passphrase', kind: 'flag', describe: 'Key passphrase.' },
    ],
    exec: async (p) => {
      const keyFile = optionalFlag(p, 'key-file');
      const creds = validateSSHCredentials({
        host: requireFlag(p, 'host'),
        port: numberFlag(p, 'port') ?? 22,
        username: requireFlag(p, 'username'),
        password: optionalFlag(p, 'password'),
        privateKey: keyFile ? await readArgFile('key-file', keyFile) : optionalFlag(p, 'privateKey'),
        passphrase: optionalFlag(p, 'passphrase'),
      });
      return testSSHConnection(creds);
    },
  },
  {
    name: 'ssh.forgetHostKey',
    group: 'ssh',
    summary: 'Drop a TOFU-pinned SSH host key (for ephemeral hosts / e2e mocks).',
    usage: 'ssh.forgetHostKey --host 1.2.3.4 --port 22',
    args: [
      { name: 'host', kind: 'flag', required: true, describe: 'IP or hostname.' },
      { name: 'port', kind: 'flag', describe: 'SSH port (default 22).' },
    ],
    exec: async (p) => {
      const { host, port } = validateHostPort(requireFlag(p, 'host'), numberFlag(p, 'port') ?? 22);
      await forgetHostKey(host, port);
      return { ok: true, host, port };
    },
  },

  // ── deploy ────────────────────────────────────────────────────────────────
  {
    name: 'deploy.start',
    group: 'deploy',
    summary: 'Kick off a deploy. Returns {jobId, nodeId} immediately.',
    usage:
      `deploy.start --target local|remote --moniker foo --gb 0.002 --hr 0.001 [--lease 0.001] --service ${SERVICE_LIST} --port 20000 [--host 1.2.3.4] [--country US] [--ssh '{...}']`,
    args: [
      { name: 'target', kind: 'flag', required: true, describe: '"local" or "remote".' },
      { name: 'moniker', kind: 'flag', required: true, describe: 'Public node name.' },
      { name: 'gb', kind: 'flag', required: true, describe: 'Per GB price.' },
      { name: 'hr', kind: 'flag', required: true, describe: 'Per hour price.' },
      { name: 'lease', kind: 'flag', describe: 'Lease price per hour (default = --hr).' },
      { name: 'service', kind: 'flag', required: true, describe: SERVICE_LIST },
      { name: 'port', kind: 'flag', required: true, describe: "First port of the node's 5-port block." },
      { name: 'host', kind: 'flag', describe: 'Public IP / DNS clients dial (default: LAN IP or SSH host).' },
      { name: 'remoteUrl', kind: 'flag', describe: 'Alias of --host.' },
      { name: 'country', kind: 'flag', describe: 'Two-letter country (default: geoip).' },
      { name: 'ssh', kind: 'flag', describe: 'JSON SSHCredentials (remote target; no multi-line keys — use --ssh-key-file).' },
      { name: 'ssh-host', kind: 'flag', describe: 'Remote host (alternative to --ssh).' },
      { name: 'ssh-user', kind: 'flag', describe: 'Remote user (default root).' },
      { name: 'ssh-port', kind: 'flag', describe: 'SSH port (default 22).' },
      { name: 'ssh-key-file', kind: 'flag', describe: 'Path to a private key file; read by the app, never echoed.' },
      { name: 'ssh-password', kind: 'flag', describe: 'Remote password (alternative to a key file).' },
    ],
    exec: async (p) => {
      const target = requireFlag(p, 'target');
      if (target !== 'local' && target !== 'remote')
        throw new Error('--target must be "local" or "remote"');
      const service = requireFlag(p, 'service');
      if (!isVpnServiceType(service))
        throw new Error(`--service must be one of ${SERVICE_LIST}`);
      const sshRaw = optionalFlag(p, 'ssh');
      // Flag form: the private key is read from disk here, because a PEM key
      // cannot survive the line tokenizer inside a JSON string.
      let ssh: SSHCredentials | undefined = sshRaw ? (JSON.parse(sshRaw) as SSHCredentials) : undefined;
      const sshHost = optionalFlag(p, 'ssh-host');
      if (sshHost && sshRaw) throw new Error('Pass either --ssh (JSON) or --ssh-host/--ssh-user/..., not both.');
      if (sshHost) {
        const keyFile = optionalFlag(p, 'ssh-key-file');
        ssh = {
          host: sshHost,
          port: numberFlag(p, 'ssh-port') ?? 22,
          username: optionalFlag(p, 'ssh-user') ?? 'root',
          privateKey: keyFile ? await readArgFile('ssh-key-file', keyFile) : undefined,
          password: optionalFlag(p, 'ssh-password'),
        };
      } else if (['ssh-user', 'ssh-port', 'ssh-key-file', 'ssh-password'].some((f) => p.flags[f] !== undefined)) {
        throw new Error('--ssh-user/--ssh-port/--ssh-key-file/--ssh-password need --ssh-host.');
      }
      if (target === 'remote' && !ssh) throw new Error('A remote deploy needs --ssh-host (+ --ssh-key-file or --ssh-password) or --ssh.');
      if (ssh) ssh = validateSSHCredentials(ssh);
      const req: DeployRequest = {
        target,
        moniker: requireFlag(p, 'moniker'),
        gigabytePriceDVPN: numberFlag(p, 'gb', true) as number,
        hourlyPriceDVPN: numberFlag(p, 'hr', true) as number,
        leaseHourlyPriceDVPN: numberFlag(p, 'lease'),
        serviceType: service,
        port: numberFlag(p, 'port', true) as number,
        remoteUrl: optionalFlag(p, 'host') ?? optionalFlag(p, 'remoteUrl'),
        country: optionalFlag(p, 'country'),
        ssh,
      };
      await primeDeploySettings();
      return startDeploy(req, () => {
        // Deploy progress is broadcast over IPC to the renderer; CLI clients
        // can poll nodes.list / nodes.status to follow up.
      });
    },
  },
  {
    name: 'deploy.cancel',
    group: 'deploy',
    summary: 'Cancel an in-flight deploy by jobId.',
    usage: 'deploy.cancel <jobId>',
    args: [{ name: 'jobId', kind: 'positional', required: true, describe: 'Job id.' }],
    exec: (p) => Promise.resolve(cancelDeploy(requirePositional(p, 0, 'jobId'))),
  },
  {
    name: 'deploy.status',
    group: 'deploy',
    summary: 'Latest progress frame for a deploy. Omit jobId to list all.',
    usage: 'deploy.status [<jobId>]',
    args: [{ name: 'jobId', kind: 'positional', describe: 'Optional job id.' }],
    // The recovery phrase is always redacted from this endpoint. The
    // previous `--reveal` flag exposed the operator mnemonic to anyone
    // with CLI pipe access; reveal must go through the renderer's gated
    // flow (with confirm) instead.
    exec: (p) => {
      const jobId = p.positional[0];
      const redact = (frame: DeployProgress | null): DeployProgress | null => {
        if (!frame) return frame;
        if (frame.mnemonicForBackup === undefined) return frame;
        return { ...frame, mnemonicForBackup: '[redacted — use the in-app reveal flow]' };
      };
      const value = jobId ? redact(getDeployProgress(jobId)) : listDeployProgress().map((f) => redact(f));
      return Promise.resolve(value);
    },
  },

  // ── updater ───────────────────────────────────────────────────────────────
  {
    name: 'updater.status',
    group: 'updater',
    summary: 'Current auto-updater state.',
    usage: 'updater.status',
    args: [],
    exec: () => Promise.resolve(getUpdaterState()),
  },
  {
    name: 'updater.check',
    group: 'updater',
    summary: 'Force a check for app updates.',
    usage: 'updater.check',
    args: [],
    exec: () => checkForUpdatesNow(),
  },
  {
    name: 'updater.install',
    group: 'updater',
    summary: 'Install a downloaded update and relaunch the app.',
    usage: 'updater.install',
    args: [],
    exec: () => Promise.resolve(installPendingUpdate()),
  },

  // ── nodes ─────────────────────────────────────────────────────────────────
  {
    name: 'nodes.list',
    group: 'nodes',
    summary: 'List every node managed by this app.',
    usage: 'nodes.list',
    args: [],
    exec: () => Promise.resolve(listNodes()),
  },
  {
    name: 'nodes.get',
    group: 'nodes',
    summary: 'Fetch a single node by id.',
    usage: 'nodes.get <nodeId>',
    args: [{ name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' }],
    exec: (p) => Promise.resolve(getNode(requireNodeId(p, 0))),
  },
  {
    name: 'nodes.start',
    group: 'nodes',
    summary: 'Start a stopped node.',
    usage: 'nodes.start <nodeId>',
    args: [{ name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' }],
    exec: (p) => startNode(requireNodeId(p, 0)),
  },
  {
    name: 'nodes.restart',
    group: 'nodes',
    summary: 'Restart a node.',
    usage: 'nodes.restart <nodeId>',
    args: [{ name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' }],
    exec: (p) => restartNode(requireNodeId(p, 0)),
  },
  {
    name: 'nodes.stop',
    group: 'nodes',
    summary: 'Stop a running node.',
    usage: 'nodes.stop <nodeId>',
    args: [{ name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' }],
    exec: (p) => stopNode(requireNodeId(p, 0)),
  },
  {
    name: 'nodes.remove',
    group: 'nodes',
    summary: 'Remove a node: redeem, stop, delist, close (bond unbonds), withdraw bond, sweep key to wallet.',
    usage: 'nodes.remove <nodeId>',
    args: [{ name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' }],
    exec: (p) => removeNode(requireNodeId(p, 0)),
  },
  {
    name: 'nodes.logs',
    group: 'nodes',
    summary: 'Tail recent log lines for a node.',
    usage: 'nodes.logs <nodeId>',
    args: [{ name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' }],
    exec: (p) => recentLogs(requireNodeId(p, 0)),
  },
  {
    name: 'nodes.exportLogs',
    group: 'nodes',
    summary: "Save the node's recent container logs (or a given buffer) to the OS temp dir.",
    usage: 'nodes.exportLogs <nodeId> --format txt|log|json [--lines \'["line1"]\']',
    args: [
      { name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' },
      { name: 'format', kind: 'flag', required: true, describe: 'txt | log | json.' },
      { name: 'lines', kind: 'flag', describe: 'JSON array of lines (default: the last 200 container log lines).' },
    ],
    exec: async (p) => {
      const fmt = requireFlag(p, 'format');
      if (fmt !== 'txt' && fmt !== 'log' && fmt !== 'json')
        throw new Error('--format must be txt | log | json');
      const nodeId = requireNodeId(p, 0);
      const raw = optionalFlag(p, 'lines');
      let lines: string[];
      if (raw !== undefined) {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) throw new Error('--lines must be a JSON array');
        lines = parsed.map(String);
      } else {
        lines = await recentLogs(nodeId);
      }
      return exportNodeLogsHeadless({ nodeId, format: fmt, lines });
    },
  },
  {
    name: 'nodes.status',
    group: 'nodes',
    summary: 'Live status for a node.',
    usage: 'nodes.status <nodeId>',
    args: [{ name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' }],
    exec: (p) => nodeStatus(requireNodeId(p, 0)),
  },
  {
    name: 'nodes.history',
    group: 'nodes',
    summary: 'Historical metrics samples for a node.',
    usage: 'nodes.history <nodeId> --window 1h|24h|7d|30d',
    args: [
      { name: 'nodeId', kind: 'positional', required: true, describe: 'Node id (or --nodeId).' },
      { name: 'nodeId', kind: 'flag', describe: 'Node id (alternative to the positional).' },
      { name: 'window', kind: 'flag', required: true, describe: '1h | 24h | 7d | 30d' },
    ],
    exec: (p) => {
      const w = requireFlag(p, 'window');
      if (!isMetricsWindow(w)) throw new Error('--window must be 1h | 24h | 7d | 30d');
      return Promise.resolve(nodeHistory(requireNodeId(p, 0, 'nodeId'), w));
    },
  },
  {
    name: 'nodes.withdraw',
    group: 'nodes',
    summary: 'Withdraw node revenue (withdraw_node_revenue) and send it to the wallet.',
    usage: 'nodes.withdraw --nodeId <id> [--amount 1.5] [--to <base58>]',
    args: [
      { name: 'nodeId', kind: 'flag', required: true, describe: 'Node id.' },
      { name: 'amount', kind: 'flag', describe: 'tDVPN amount (default: everything).' },
      { name: 'to', kind: 'flag', describe: 'Defaults to app wallet.' },
    ],
    exec: async (p) => {
      const req: NodeWithdrawRequest = {
        nodeId: requireNodeId(p, -1, 'nodeId'),
        amountDVPN: numberFlag(p, 'amount'),
        to: optionalFlag(p, 'to'),
      };
      const store = await readStore();
      const to = req.to ?? store.wallet?.address;
      if (!to) return { ok: false, error: 'No destination: app wallet not set up.' };
      return withdrawFromNode(req.nodeId, to, req.amountDVPN);
    },
  },
  {
    name: 'nodes.updatePricing',
    group: 'nodes',
    summary: 'Set the three node prices; the daemon pushes them on chain (update_node) on restart.',
    usage: 'nodes.updatePricing --nodeId <id> --gb 0.002 --hr 0.001 [--lease 0.001]',
    args: [
      { name: 'nodeId', kind: 'flag', required: true, describe: 'Node id.' },
      { name: 'gb', kind: 'flag', required: true, describe: 'tDVPN per GB (channel).' },
      { name: 'hr', kind: 'flag', required: true, describe: 'tDVPN per hour (channel).' },
      { name: 'lease', kind: 'flag', describe: 'tDVPN per hour (lease). Defaults to the current value.' },
    ],
    exec: (p) => {
      const req: UpdateNodePricingRequest = {
        nodeId: requireNodeId(p, -1, 'nodeId'),
        gigabytePriceDVPN: numberFlag(p, 'gb', true) as number,
        hourlyPriceDVPN: numberFlag(p, 'hr', true) as number,
        leaseHourlyPriceDVPN: numberFlag(p, 'lease'),
      };
      return updateNodePricing(req.nodeId, req.gigabytePriceDVPN, req.hourlyPriceDVPN, {
        leaseHourlyPriceDVPN: req.leaseHourlyPriceDVPN,
      });
    },
  },
  {
    name: 'nodes.setProtocol',
    group: 'nodes',
    summary: 'Switch the one protocol a node serves; waits until the on-chain bit follows.',
    usage: `nodes.setProtocol <nodeId> --service ${SERVICE_LIST}`,
    args: [
      { name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' },
      { name: 'service', kind: 'flag', required: true, describe: SERVICE_LIST },
    ],
    exec: (p) => {
      const service = requireFlag(p, 'service');
      if (!isVpnServiceType(service)) throw new Error(`--service must be one of ${SERVICE_LIST}`);
      return setNodeProtocol(requireNodeId(p, 0), service);
    },
  },
  {
    name: 'nodes.redeem',
    group: 'nodes',
    summary: 'Ask the node daemon to redeem client vouchers on chain now.',
    usage: 'nodes.redeem <nodeId>',
    args: [{ name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' }],
    exec: (p) => redeemNow(requireNodeId(p, 0)),
  },
  {
    name: 'nodes.relist',
    group: 'nodes',
    summary: 'Re-list the node now (daemon heartbeat, or list_node if the daemon is down).',
    usage: 'nodes.relist <nodeId>',
    args: [{ name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' }],
    exec: (p) => relistNow(requireNodeId(p, 0)),
  },
  {
    name: 'nodes.chain',
    group: 'nodes',
    summary: "The node's on-chain account as the program stores it (any node: this app's id or a chain address).",
    usage: 'nodes.chain <nodeId|nodeAddress>',
    args: [{ name: 'node', kind: 'positional', required: true, describe: "This app's node id, or any node's on-chain address." }],
    exec: (p) => chainNodeByRef(requireNodeRef(p, 0, 'node')),
  },
  {
    name: 'nodes.watch',
    group: 'nodes',
    summary: 'Follow a node this app did not deploy, read-only (its chain state; no key, no host).',
    usage: 'nodes.watch <nodeAddress> [--label <text>]',
    args: [
      { name: 'nodeAddress', kind: 'positional', required: true, describe: "The node's on-chain address." },
      { name: 'label', kind: 'flag', describe: 'A name for it (64 chars max).' },
    ],
    exec: (p) => watchNode(requireNodeRef(p, 0, 'nodeAddress'), optionalFlag(p, 'label')),
  },
  {
    name: 'nodes.unwatch',
    group: 'nodes',
    summary: 'Stop following a watched node.',
    usage: 'nodes.unwatch <nodeAddress>',
    args: [{ name: 'nodeAddress', kind: 'positional', required: true, describe: "The node's on-chain address." }],
    exec: (p) => unwatchNode(requireNodeRef(p, 0, 'nodeAddress')),
  },
  {
    name: 'nodes.watched',
    group: 'nodes',
    summary: 'Watched nodes (not deployed by this app) with their current chain state.',
    usage: 'nodes.watched',
    args: [],
    exec: () => watchedNodes(),
  },
  {
    name: 'nodes.test',
    group: 'nodes',
    summary: 'Run a real paid session against the node from a throwaway client container (wallet pays).',
    usage: 'nodes.test <nodeId> [--client host|here]',
    args: [
      { name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' },
      { name: 'client', kind: 'flag', describe: "Where the paying client runs: 'host' (the node's host, default) or 'here' (this machine — a real outside client for a remote node)." },
    ],
    exec: (p) => {
      const c = optionalFlag(p, 'client') ?? 'host';
      if (c !== 'host' && c !== 'here') throw new Error('--client must be host or here');
      return testNodeSession(requireNodeId(p, 0), { clientOn: c });
    },
  },
  {
    name: 'nodes.sweepTestChannels',
    group: 'nodes',
    summary: 'Start-close / close test channels and withdraw their refunds to the wallet.',
    usage: 'nodes.sweepTestChannels [--dry-run]',
    args: [{ name: 'dry-run', kind: 'bool', describe: 'Report what would be sent; send nothing.' }],
    exec: (p) => sweepTestChannels({ dryRun: boolFlag(p, 'dry-run') }),
  },
  {
    name: 'nodes.leases',
    group: 'nodes',
    summary: 'Leases on this node as the program stores them (providers pre-paying the node per hour).',
    usage: 'nodes.leases <nodeId|nodeAddress>',
    args: [{ name: 'node', kind: 'positional', required: true, describe: "This app's node id, or any node's on-chain address." }],
    exec: (p) => nodeLeasesByRef(requireNodeRef(p, 0, 'node')),
  },
  {
    name: 'nodes.withdrawBond',
    group: 'nodes',
    summary: 'Finish a removal: withdraw the bond once unbonding has elapsed, then sweep the node key.',
    usage: 'nodes.withdrawBond <nodeId>',
    args: [{ name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' }],
    exec: (p) => withdrawBondNow(requireNodeId(p, 0)),
  },
  {
    name: 'nodes.forgetServer',
    group: 'nodes',
    summary: "Finish a removal whose server no longer exists: only once the bond and node key are back in the wallet. The server's firewall rules and node directory are not cleaned.",
    usage: 'nodes.forgetServer <nodeId>',
    args: [{ name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' }],
    exec: (p) => forgetServerNow(requireNodeId(p, 0)),
  },
  {
    name: 'nodes.specs',
    group: 'nodes',
    summary: 'Read back the latest specs:v1 memo the node key published on chain.',
    usage: 'nodes.specs <nodeId>',
    args: [{ name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' }],
    exec: (p) => readPublishedSpecs(requireNodeId(p, 0)),
  },

  {
    name: 'nodes.publishSpecs',
    group: 'nodes',
    summary:
      'Publish on-chain hardware specs (specs:v1 SPL Memo signed by the node key). Idempotent by default — pass --force for a fresh attestation.',
    usage: 'nodes.publishSpecs <nodeId> [--force]',
    args: [
      { name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' },
      {
        name: 'force',
        kind: 'bool',
        required: false,
        describe: 'Bypass the idempotency short-circuit and post a fresh on-chain attestation.',
      },
    ],
    exec: (p) => publishNodeSpecs(requireNodeId(p, 0), { force: boolFlag(p, 'force') }),
  },
  {
    name: 'nodes.sessions',
    group: 'nodes',
    summary: 'Sessions the node daemon is serving right now.',
    usage: 'nodes.sessions <nodeId>',
    args: [{ name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' }],
    exec: (p) => nodeSessions(requireNodeId(p, 0)),
  },
  {
    name: 'nodes.session',
    group: 'nodes',
    summary: 'One session the node is serving.',
    usage: 'nodes.session <nodeId> --id <sessionId>',
    args: [
      { name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' },
      { name: 'id', kind: 'flag', required: true, describe: 'Session id.' },
    ],
    exec: (p) => nodeSession(requireNodeId(p, 0), requireFlag(p, 'id')),
  },
  {
    name: 'nodes.closeSession',
    group: 'nodes',
    summary: 'Close a session (also frees a stale peer slot that causes peer_limit_reached).',
    usage: 'nodes.closeSession <nodeId> --id <sessionId>',
    args: [
      { name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' },
      { name: 'id', kind: 'flag', required: true, describe: 'Session id.' },
    ],
    exec: (p) => closeNodeSession(requireNodeId(p, 0), requireFlag(p, 'id')),
  },
  {
    name: 'nodes.positions',
    group: 'nodes',
    summary: 'Channels and leases the node daemon is watching (what it can redeem).',
    usage: 'nodes.positions <nodeId>',
    args: [{ name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' }],
    exec: (p) => nodePositions(requireNodeId(p, 0)),
  },
  {
    name: 'nodes.redemptions',
    group: 'nodes',
    summary: 'Past voucher redemptions (earnings history from the daemon).',
    usage: 'nodes.redemptions <nodeId>',
    args: [{ name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' }],
    exec: (p) => nodeRedemptions(requireNodeId(p, 0)),
  },
  {
    name: 'nodes.inspect',
    group: 'nodes',
    summary: "Verify the node's signed metadata + TLS pin like a client does, and that it is discoverable.",
    usage: 'nodes.inspect <nodeId>',
    args: [{ name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' }],
    exec: (p) => inspectNodeTrust(requireNodeId(p, 0)),
  },
  {
    name: 'nodes.daemon',
    group: 'nodes',
    summary: "The node daemon's own status and version (control socket).",
    usage: 'nodes.daemon <nodeId>',
    args: [{ name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' }],
    exec: (p) => nodeDaemonInfo(requireNodeId(p, 0)),
  },
  {
    name: 'program.status',
    group: 'system',
    summary: 'dvpn program parameters and pause mask (devnet).',
    usage: 'program.status',
    args: [],
    exec: () => programOverview(),
  },
  {
    name: 'nodes.reconnect',
    group: 'nodes',
    summary: 'Re-attach SSH credentials (memory-only) to every node on a host after an app restart.',
    usage: 'nodes.reconnect --ssh-host 1.2.3.4 --ssh-user root [--ssh-port 22] (--ssh-key-file <path> | --ssh-password <pw>)',
    args: [
      { name: 'ssh-host', kind: 'flag', required: true, describe: 'Host.' },
      { name: 'ssh-user', kind: 'flag', describe: 'User (default root).' },
      { name: 'ssh-port', kind: 'flag', describe: 'Port (default 22).' },
      { name: 'ssh-key-file', kind: 'flag', describe: 'Private key file path.' },
      { name: 'ssh-password', kind: 'flag', describe: 'Password.' },
    ],
    exec: async (p) => {
      const keyFile = optionalFlag(p, 'ssh-key-file');
      return reconnectHost(
        validateSSHCredentials({
          host: requireFlag(p, 'ssh-host'),
          port: numberFlag(p, 'ssh-port') ?? 22,
          username: optionalFlag(p, 'ssh-user') ?? 'root',
          privateKey: keyFile ? await readArgFile('ssh-key-file', keyFile) : undefined,
          password: optionalFlag(p, 'ssh-password'),
        }),
      );
    },
  },
  {
    name: 'nodes.cleanHostLeftovers',
    group: 'nodes',
    summary: 'Delete node directories a host still holds for nodes the app no longer tracks.',
    usage: 'nodes.cleanHostLeftovers [--dry-run] [--ssh-host 1.2.3.4 --ssh-user root [--ssh-port 22] (--ssh-key-file <path> | --ssh-password <pw>)]',
    args: [
      { name: 'dry-run', kind: 'bool', describe: 'Only report what would be deleted.' },
      { name: 'ssh-host', kind: 'flag', describe: 'Remote host (omit for this machine).' },
      { name: 'ssh-user', kind: 'flag', describe: 'User (default root).' },
      { name: 'ssh-port', kind: 'flag', describe: 'Port (default 22).' },
      { name: 'ssh-key-file', kind: 'flag', describe: 'Private key file path.' },
      { name: 'ssh-password', kind: 'flag', describe: 'Password.' },
    ],
    exec: async (p) => {
      const host = optionalFlag(p, 'ssh-host');
      const keyFile = optionalFlag(p, 'ssh-key-file');
      const creds = host
        ? validateSSHCredentials({
            host,
            port: numberFlag(p, 'ssh-port') ?? 22,
            username: optionalFlag(p, 'ssh-user') ?? 'root',
            privateKey: keyFile ? await readArgFile('ssh-key-file', keyFile) : undefined,
            password: optionalFlag(p, 'ssh-password'),
          })
        : undefined;
      return cleanHostLeftovers(creds, { dryRun: boolFlag(p, 'dry-run') });
    },
  },
  {
    name: 'nodes.backupMnemonic',
    group: 'nodes',
    summary: "Encrypt + store a node operator's mnemonic with the OS keychain.",
    usage: 'nodes.backupMnemonic <nodeId> --mnemonic "word1 ..."',
    args: [
      { name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' },
      { name: 'mnemonic', kind: 'flag', required: true, describe: 'BIP-39 mnemonic.' },
    ],
    exec: async (p) => {
      const nodeId = requireNodeId(p, 0);
      if (!(await getNode(nodeId))) throw new Error('Node not found');
      const mnemonic = requireFlag(p, 'mnemonic');
      if (!isValidMnemonic(mnemonic)) throw new Error('That is not a valid BIP-39 phrase.');
      if (!safeStorage.isEncryptionAvailable()) {
        return { ok: false, error: 'OS keychain unavailable — cannot back up.' };
      }
      const store = await readStore();
      store.nodeBackups[nodeId] = safeStorage.encryptString(mnemonic).toString('base64');
      await writeStore(store);
      return { ok: true };
    },
  },
  {
    name: 'nodes.revealMnemonic',
    group: 'nodes',
    summary: 'Decrypt a previously stored node-operator mnemonic.',
    usage: 'nodes.revealMnemonic <nodeId>',
    args: [{ name: 'nodeId', kind: 'positional', required: true, describe: 'Node id.' }],
    exec: async (p) => {
      const nodeId = requireNodeId(p, 0);
      const store = await readStore();
      const blob = store.nodeBackups[nodeId];
      if (!blob) return { ok: false, error: 'No mnemonic backup is stored for this node.' };
      if (!safeStorage.isEncryptionAvailable())
        return { ok: false, error: 'OS keychain unavailable.' };
      try {
        const mnemonic = safeStorage.decryptString(Buffer.from(blob, 'base64'));
        return { ok: true, mnemonic };
      } catch (err) {
        return { ok: false, error: `Failed to decrypt: ${(err as Error).message}` };
      }
    },
  },
];

const BY_NAME: Record<string, MainCliCommand> = Object.fromEntries(
  MAIN_COMMANDS.map((c) => [c.name, c]),
);

export interface RunResult {
  ok: boolean;
  text: string;
  error?: string;
}

const helpText = (): string => {
  const lines = ['Available commands:'];
  for (const c of MAIN_COMMANDS) {
    lines.push(`  ${c.name.padEnd(28)} ${c.summary}`);
  }
  lines.push('');
  lines.push('Built-in:');
  lines.push('  help [command]               Print this help, or one command in detail.');
  lines.push('  exit / quit                  Disconnect (CLI clients only).');
  return lines.join('\n');
};

export async function runCommand(line: string): Promise<RunResult> {
  const trimmed = line.trim();
  if (!trimmed) return { ok: true, text: '' };
  if (trimmed === 'help') return { ok: true, text: helpText() };
  if (trimmed === 'exit' || trimmed === 'quit') return { ok: true, text: '(the in-app prompt has nothing to disconnect; CLI clients handle exit themselves)' };

  let tokens: string[];
  try {
    tokens = tokenize(trimmed);
  } catch (err) {
    return { ok: false, text: '', error: (err as Error).message };
  }
  if (tokens[0] === 'help' && tokens[1]) {
    const c = BY_NAME[tokens[1]];
    if (!c) return { ok: false, text: '', error: `Unknown command: ${tokens[1]}` };
    const args = c.args.length ? c.args.map((a) => `  ${a.kind === 'positional' ? `<${a.name}>` : `--${a.name}`}${a.required ? '' : ' (optional)'}  ${a.describe}`).join('\n') : '  (no arguments)';
    return { ok: true, text: `${c.name} — ${c.summary}\nUsage: ${c.usage}\n${args}` };
  }
  const cmd = BY_NAME[tokens[0]];
  if (!cmd) {
    return {
      ok: false,
      text: '',
      error: `Unknown command: ${tokens[0]}. Type 'help' to see every command.`,
    };
  }
  try {
    const parsed = parseArgs(tokens.slice(1), new Set(cmd.args.filter((a) => a.kind === 'bool').map((a) => a.name)));
    checkArgs(cmd.name, cmd.usage, cmd.args, parsed);
    const result = await cmd.exec(parsed);
    const text =
      result === undefined
        ? '(ok — no value)'
        : typeof result === 'string'
          ? result
          : JSON.stringify(result, null, 2);
    return { ok: true, text };
  } catch (err) {
    return { ok: false, text: '', error: (err as Error).message };
  }
}
