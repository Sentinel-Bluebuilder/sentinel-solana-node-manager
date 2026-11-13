import { BrowserWindow, app, dialog, ipcMain, safeStorage, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import {
  IPC,
  type AppSettings,
  type DeployProgress,
  type DeployRequest,
  type LocalSystemReport,
  type MetricsWindow,
  type MnemonicExportResult,
  type NodeLogExportRequest,
  type NodeLogExportResult,
  type NodeWithdrawRequest,
  type SSHCredentials,
  type SSHTestResult,
  type SendTxRequest,
  type UpdateNodePricingRequest,
  type SetProtocolRequest,
  type SetHandshakeDnsRequest,
} from '../shared/types';
import { testSSHConnection } from './services/ssh';
import { vUUID, validateSSHCredentials, validateHostPort, clampEventLimit } from './services/validate';
import { writeDiagnosticsZip, renderLogExport } from './services/diagnostics';
import { forgetHostKey } from './services/host-keys';
import { publishNodeSpecs } from './services/node-specs';
import {
  startDeploy,
  cancelDeploy,
  primeDeploySettings,
  getDeployProgress,
  listDeployProgress,
} from './services/deploy';
import {
  getWallet,
  createWallet,
  restoreWallet,
  refreshWalletBalance,
  sendTokens,
  logoutWallet,
  importKeyFile,
} from './services/wallet';
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
  reapStuckNow,
  setNodeProtocol,
  setNodeHandshakeDns,
  useChainHost,
  chainHostLabel,
  redeemNow,
  relistNow,
  withdrawBondNow,
  retryRemovalNow,
  forgetServerNow,
  testNodeSession,
} from './services/nodes';
import { autoSweepTestChannels, sweepTestChannels, testEscrowStatus } from './services/test-channels';
import {
  closeNodeSession,
  inspectNodeTrust,
  nodeDaemonInfo,
  nodePositions,
  nodeRedemptions,
  nodeSessions,
  programOverview,
  reconnectHost,
  hasSSH,
  nodeLeases,
} from './services/node-manager';
import { listEvents } from './services/events';
import { getSettings, updateSettings } from './services/settings';
import {
  startDockerDesktop,
  resetDockerClient,
  dockerOverview,
  stopAllSentinelContainers,
  pruneDangling,
  quitDockerDesktop,
  forceQuitDockerDesktop,
} from './services/docker';
import { healthAll, invalidateHealthCache } from './services/solana-client';
import { buildLocalSystemReport } from './services/system-report';
import { startLiveStats, stopLiveStats } from './services/live-stats';
import { log } from './services/logger';
import { readStore, writeStore } from './services/store';
import {
  getCliState,
  runFromApp,
  startCliServer,
  stopCliServer,
} from './services/cli-server';
import { spawn } from 'node:child_process';
import { MAIN_COMMANDS, runCommand } from './services/cli-registry';

// ─── IPC payload validators ──────────────────────────────────────────────────
//
// The renderer is sandboxed (contextIsolation), but we still treat every
// IPC payload as untrusted: a renderer compromise is the most likely
// attack vector for a desktop app. Validators throw on bad input so
// `ipcMain.handle` returns a structured error to the caller instead of
// silently passing malformed data into the service layer.

function broadcast(channel: string, payload: unknown) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

// Token-bucket rate limiter: protects expensive / state-changing IPC
// channels from a runaway renderer. Capacity = burst, refill = per-second.
// All limiter state lives in-process and resets on app restart.
type Bucket = { tokens: number; last: number };
const RATE_BUCKETS = new Map<string, Bucket>();
function rateOk(key: string, capacity: number, refillPerSec: number): boolean {
  const now = Date.now();
  const b = RATE_BUCKETS.get(key) ?? { tokens: capacity, last: now };
  const elapsed = (now - b.last) / 1000;
  b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerSec);
  b.last = now;
  if (b.tokens < 1) {
    RATE_BUCKETS.set(key, b);
    return false;
  }
  b.tokens -= 1;
  RATE_BUCKETS.set(key, b);
  return true;
}
function enforceRate(key: string, capacity: number, refillPerSec: number): void {
  if (!rateOk(key, capacity, refillPerSec)) {
    throw new Error('You\'re going a bit too fast. Please wait a few seconds and try again.');
  }
}

// Convert a thrown error into a user-safe message: strip stack frames,
// absolute paths (which may contain the OS username), and runaway length.
// The full error is still logged via the main-process logger for triage.
function toUserError(err: unknown, ctx?: string): string {
  const raw = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  let msg = raw.split('\n')[0] ?? raw;
  // Replace any Windows or POSIX absolute path with a placeholder.
  msg = msg.replace(/[A-Za-z]:\\[^\s'"]+/g, '<path>');
  msg = msg.replace(/\/(?:home|Users|root|etc|var|tmp)\/[^\s'"]+/g, '<path>');
  if (msg.length > 400) msg = msg.slice(0, 400) + '…';
  if (ctx) log.warn(`ipc handler error: ${ctx}`, { err: String(err) });
  return msg;
}

async function reportLocalSystem(): Promise<LocalSystemReport> {
  return buildLocalSystemReport();
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.SYSTEM_REPORT, reportLocalSystem);
  ipcMain.handle(IPC.SYSTEM_LIVE_STATS_START, () => {
    startLiveStats();
    return { ok: true };
  });
  ipcMain.handle(IPC.SYSTEM_LIVE_STATS_STOP, () => {
    stopLiveStats();
    return { ok: true };
  });
  ipcMain.handle(IPC.DOCKER_START, async () => {
    const result = await startDockerDesktop();
    // Clear the cached Docker client so once the daemon finishes booting,
    // the next `dockerHealth()` re-probes sockets instead of returning
    // the stale "not reachable" client.
    resetDockerClient();
    return result;
  });
  ipcMain.handle(IPC.DOCKER_OVERVIEW, () => dockerOverview());
  ipcMain.handle(IPC.DOCKER_STOP_ALL_SENTINEL, () => stopAllSentinelContainers());
  ipcMain.handle(IPC.DOCKER_PRUNE, () => pruneDangling());
  ipcMain.handle(IPC.DOCKER_OPEN_SETTINGS, async () => {
    // Docker Desktop has no public deep-link to the Resources pane (the
    // `docker-desktop://` scheme only handles launch + OAuth callbacks),
    // so we just bring Docker Desktop itself to the front and the
    // renderer tells the user to navigate to Settings → Resources. On
    // Linux there is no Docker Desktop GUI.
    if (process.platform === 'linux') {
      return {
        ok: false,
        error: 'On Linux, Docker resources are configured via /etc/docker/daemon.json and a daemon restart.',
      };
    }
    const result = await startDockerDesktop();
    if (result.started) return { ok: true };
    return {
      ok: false,
      error: result.error ?? 'Docker Desktop could not be opened.',
    };
  });
  ipcMain.handle(IPC.DOCKER_QUIT, async () => {
    const result = await quitDockerDesktop();
    resetDockerClient();
    return result;
  });
  ipcMain.handle(IPC.DOCKER_FORCE_QUIT, async () => {
    const result = await forceQuitDockerDesktop();
    resetDockerClient();
    return result;
  });

  // -- Settings --------------------------------------------------------------
  ipcMain.handle(IPC.SETTINGS_GET, () => getSettings());
  ipcMain.handle(IPC.SETTINGS_SET, async (_e, patch: Partial<AppSettings>) => {
    const next = await updateSettings(patch);
    invalidateHealthCache();
    await primeDeploySettings();
    return next;
  });
  ipcMain.handle(IPC.CHAIN_HEALTH, () => healthAll());

  // -- Wallet ----------------------------------------------------------------
  ipcMain.handle(IPC.WALLET_GET, () => getWallet());
  ipcMain.handle(IPC.WALLET_CREATE, () => createWallet());
  ipcMain.handle(IPC.WALLET_RESTORE, (_e, mnemonic: string) => restoreWallet(mnemonic));
  ipcMain.handle(IPC.WALLET_REFRESH_BALANCE, () => refreshWalletBalance());
  ipcMain.handle(IPC.WALLET_SEND, (_e, req: SendTxRequest) => {
    enforceRate('wallet-send', 5, 0.5); // 5 burst, ~one every 2s after that
    return sendTokens(req);
  });
  ipcMain.handle(IPC.WALLET_QR, (_e, text: string) =>
    QRCode.toString(text, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      color: { dark: '#0B1020', light: '#FFFFFF' },
    }),
  );
  ipcMain.handle(IPC.WALLET_LOGOUT, () => logoutWallet());
  ipcMain.handle(IPC.WALLET_IMPORT_KEY, (_e, body: string) => {
    if (typeof body !== 'string' || body.length > 4096) throw new Error('key file body must be a short JSON string');
    return importKeyFile(body);
  });

  // -- Events ----------------------------------------------------------------
  ipcMain.handle(IPC.EVENTS_LIST, (_e, limit?: number) => listEvents(clampEventLimit(limit)));

  // -- SSH -------------------------------------------------------------------
  ipcMain.handle(
    IPC.SSH_TEST,
    (_e, creds: SSHCredentials): Promise<SSHTestResult> =>
      testSSHConnection(validateSSHCredentials(creds)),
  );
  ipcMain.handle(
    IPC.SSH_FORGET_HOST_KEY,
    async (_e, req: { host: string; port?: number }) => {
      if (!req || typeof req !== 'object') throw new Error('Invalid forget-host-key request');
      const { host, port } = validateHostPort(req.host, req.port);
      await forgetHostKey(host, port);
      return { ok: true };
    },
  );

  // -- Deploy ----------------------------------------------------------------
  ipcMain.handle(IPC.DEPLOY_START, async (_e, req: DeployRequest) => {
    enforceRate('deploy-start', 3, 0.2); // 3 burst, then 1 every 5s
    if (req && typeof req === 'object' && req.ssh) validateSSHCredentials(req.ssh);
    await primeDeploySettings();
    return startDeploy(req, () => {
      // deploy.ts broadcasts every frame itself (so CLI-started deploys reach the UI too).
    });
  });
  ipcMain.handle(IPC.DEPLOY_CANCEL, (_e, jobId: string) => cancelDeploy(jobId));
  ipcMain.handle(IPC.DEPLOY_STATUS, (_e, jobId?: string) =>
    jobId ? getDeployProgress(jobId) : listDeployProgress(),
  );

  // -- Nodes -----------------------------------------------------------------
  ipcMain.handle(IPC.NODES_LIST, () => listNodes());
  ipcMain.handle(IPC.NODES_GET, (_e, id: string) => getNode(vUUID(id, 'node id')));
  ipcMain.handle(IPC.NODES_RESTART, (_e, id: string) => restartNode(vUUID(id, 'node id')));
  ipcMain.handle(IPC.NODES_STOP, (_e, id: string) => stopNode(vUUID(id, 'node id')));
  ipcMain.handle(IPC.NODES_START, (_e, id: string) => startNode(vUUID(id, 'node id')));
  ipcMain.handle(IPC.NODES_REMOVE, (_e, id: string) => removeNode(vUUID(id, 'node id')));
  ipcMain.handle(IPC.NODES_REAP_STUCK, () => reapStuckNow());
  ipcMain.handle(IPC.NODES_LOGS, (_e, id: string) => recentLogs(vUUID(id, 'node id')));
  ipcMain.handle(
    IPC.NODES_EXPORT_LOGS,
    async (_e, req: NodeLogExportRequest): Promise<NodeLogExportResult> =>
      exportNodeLogs(req),
  );
  ipcMain.handle(IPC.NODES_STATUS, (_e, id: string) => nodeStatus(vUUID(id, 'node id')));
  ipcMain.handle(IPC.NODES_HISTORY, (_e, id: string, window: MetricsWindow) => {
    if (!['1h', '24h', '7d', '30d'].includes(window)) throw new Error('Invalid metrics window');
    return nodeHistory(vUUID(id, 'node id'), window);
  });
  ipcMain.handle(IPC.NODES_WITHDRAW, async (_e, req: NodeWithdrawRequest) => {
    enforceRate('nodes-withdraw', 5, 0.5);
    vUUID(req?.nodeId, 'node id');
    const store = await readStore();
    const to = req.to ?? store.wallet?.address;
    if (!to) return { ok: false, error: 'No destination: app wallet not set up.' };
    return withdrawFromNode(req.nodeId, to, req.amountDVPN);
  });
  ipcMain.handle(IPC.NODES_UPDATE_PRICING, async (_e, req: UpdateNodePricingRequest) => {
    enforceRate('nodes-update-pricing', 5, 0.5);
    vUUID(req?.nodeId, 'node id');
    return updateNodePricing(req.nodeId, req.gigabytePriceDVPN, req.hourlyPriceDVPN, {
      leaseHourlyPriceDVPN: req.leaseHourlyPriceDVPN,
    });
  });
  ipcMain.handle(IPC.NODES_SET_PROTOCOL, async (_e, req: SetProtocolRequest) => {
    enforceRate('nodes-set-protocol', 3, 0.2);
    return setNodeProtocol(vUUID(req?.nodeId, 'node id'), req.serviceType);
  });
  ipcMain.handle(IPC.CHAIN_HOST_SET, async (_e, creds: SSHCredentials | null) => {
    enforceRate('chain-host-set', 3, 0.1);
    return useChainHost(creds ? validateSSHCredentials(creds) : null);
  });
  ipcMain.handle(IPC.CHAIN_HOST_GET, () => chainHostLabel());
  ipcMain.handle(IPC.NODES_SET_HANDSHAKE_DNS, async (_e, req: SetHandshakeDnsRequest) => {
    enforceRate('nodes-set-hns', 3, 0.2);
    if (typeof req?.enabled !== 'boolean') throw new Error('enabled must be true or false');
    return setNodeHandshakeDns(vUUID(req.nodeId, 'node id'), req.enabled);
  });
  ipcMain.handle(IPC.NODES_REDEEM, (_e, id: string) => redeemNow(vUUID(id, 'node id')));
  ipcMain.handle(IPC.NODES_RELIST, (_e, id: string) => relistNow(vUUID(id, 'node id')));
  ipcMain.handle(IPC.NODES_WITHDRAW_BOND, (_e, id: string) => withdrawBondNow(vUUID(id, 'node id')));
  ipcMain.handle(IPC.NODES_RETRY_REMOVAL, (_e, id: string) => {
    enforceRate('retry-removal', 5, 0.2);
    return retryRemovalNow(vUUID(id, 'node id'));
  });
  ipcMain.handle(IPC.NODES_FORGET_SERVER, (_e, id: string) => forgetServerNow(vUUID(id, 'node id')));
  ipcMain.handle(IPC.NODES_TEST, (_e, id: string, opts?: { clientOn?: 'host' | 'here' }) => {
    enforceRate('nodes-test', 2, 0.05);
    const clientOn = opts?.clientOn === 'here' ? 'here' : 'host';
    return testNodeSession(vUUID(id, 'node id'), { clientOn });
  });
  ipcMain.handle(IPC.NODES_SWEEP_TEST_CHANNELS, (_e, opts?: { dryRun?: boolean }) => sweepTestChannels({ dryRun: !!opts?.dryRun }));
  ipcMain.handle(IPC.TEST_ESCROW_STATUS, () => testEscrowStatus());
  ipcMain.handle(IPC.TEST_ESCROW_RECLAIM, async () => {
    enforceRate('test-escrow-reclaim', 3, 0.05);
    return autoSweepTestChannels({ force: true });
  });
  ipcMain.handle(IPC.NODES_LEASES, (_e, id: string) => nodeLeases(vUUID(id, 'node id')));
  ipcMain.handle(IPC.NODES_SESSIONS, (_e, id: string) => nodeSessions(vUUID(id, 'node id')));
  ipcMain.handle(IPC.NODES_CLOSE_SESSION, (_e, id: string, sid: string) => {
    if (typeof sid !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(sid)) throw new Error('invalid session id');
    return closeNodeSession(vUUID(id, 'node id'), sid);
  });
  ipcMain.handle(IPC.NODES_POSITIONS, (_e, id: string) => nodePositions(vUUID(id, 'node id')));
  ipcMain.handle(IPC.NODES_REDEMPTIONS, (_e, id: string) => nodeRedemptions(vUUID(id, 'node id')));
  ipcMain.handle(IPC.NODES_INSPECT, (_e, id: string) => inspectNodeTrust(vUUID(id, 'node id')));
  ipcMain.handle(IPC.NODES_DAEMON, (_e, id: string) => nodeDaemonInfo(vUUID(id, 'node id')));
  ipcMain.handle(IPC.PROGRAM_STATUS, () => programOverview());
  ipcMain.handle(IPC.NODES_RECONNECT, (_e, creds: SSHCredentials) => reconnectHost(validateSSHCredentials(creds)));
  ipcMain.handle(IPC.NODES_SSH_STATUS, (_e, id: string) => hasSSH(vUUID(id, 'node id')));
  ipcMain.handle(
    IPC.NODES_PUBLISH_SPECS,
    async (_e, nodeId: string, opts?: { force?: boolean }) => {
      enforceRate('nodes-publish-specs', 3, 0.2); // memo tx on chain — keep tight
      return publishNodeSpecs(vUUID(nodeId, 'node id'), {
        force: !!opts?.force,
      });
    },
  );

  ipcMain.handle(IPC.NODES_BACKUP_MNEMONIC, async (_e, nodeId: string, mnemonic: string) => {
    vUUID(nodeId, 'node id');
    if (typeof mnemonic !== 'string' || !mnemonic.trim()) return { ok: false, error: 'No mnemonic to back up.' };
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'OS keychain unavailable — cannot back up.' };
    }
    const store = await readStore();
    store.nodeBackups[nodeId] = safeStorage.encryptString(mnemonic).toString('base64');
    await writeStore(store);
    return { ok: true };
  });

  ipcMain.handle(
    IPC.NODES_EXPORT_MNEMONIC,
    async (_e, nodeId: string, mnemonic: string): Promise<MnemonicExportResult> => {
      vUUID(nodeId, 'node id');
      if (typeof mnemonic !== 'string' || !mnemonic.trim()) {
        return { ok: false, error: 'No mnemonic to export.' };
      }
      const date = new Date().toISOString().split('T')[0];
      const { filePath, canceled } = await dialog.showSaveDialog({
        title: 'Export recovery phrase',
        defaultPath: `sentinel-recovery-${nodeId.slice(0, 8)}-${date}.txt`,
        filters: [{ name: 'Text file', extensions: ['txt'] }],
      });
      if (canceled || !filePath) return { ok: false, cancelled: true };
      try {
        const body =
          `# Sentinel node recovery phrase\n` +
          `# Node: ${nodeId}\n` +
          `# Exported: ${new Date().toISOString()}\n` +
          `# Keep this file offline. Anyone with these words can control the operator wallet.\n\n` +
          `${mnemonic.trim()}\n`;
        await fs.writeFile(filePath, body, { encoding: 'utf8', mode: 0o600 });
        shell.showItemInFolder(filePath);
        return { ok: true, path: filePath };
      } catch (err) {
        return { ok: false, error: toUserError(err, 'mnemonic-export') };
      }
    },
  );

  ipcMain.handle(IPC.NODES_REVEAL_MNEMONIC, async (_e, nodeId: string) => {
    vUUID(nodeId, 'node id');
    const store = await readStore();
    const blob = store.nodeBackups[nodeId];
    if (!blob) {
      return {
        ok: false,
        error:
          'No mnemonic backup is stored for this node. The mnemonic is shown only once during deploy; if you skipped saving the encrypted backup then, it cannot be recovered here.',
      };
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'OS keychain unavailable — cannot decrypt backup.' };
    }
    try {
      const mnemonic = safeStorage.decryptString(Buffer.from(blob, 'base64'));
      return { ok: true, mnemonic };
    } catch (err) {
      return { ok: false, error: `Failed to decrypt backup: ${toUserError(err, 'mnemonic-decrypt')}` };
    }
  });

  // -- CLI server ------------------------------------------------------------
  ipcMain.handle(IPC.CLI_STATUS, () => getCliState());
  ipcMain.handle(IPC.CLI_START, async () => {
    try {
      return await startCliServer();
    } catch (err) {
      return { ...getCliState(), error: toUserError(err, 'cli-start') };
    }
  });
  ipcMain.handle(IPC.CLI_STOP, () => stopCliServer());
  // Single registry: the renderer reads command metadata and executes through main.
  ipcMain.handle(IPC.CLI_COMMANDS, () =>
    MAIN_COMMANDS.map((c) => ({ name: c.name, group: c.group, summary: c.summary, usage: c.usage, args: c.args })),
  );
  ipcMain.handle(IPC.CLI_EXEC, (_e, line: string) => {
    if (typeof line !== 'string' || line.length > 20_000) throw new Error('invalid command line');
    return runCommand(line);
  });
  ipcMain.handle(IPC.CLI_RUN, async (_e, line: string) => {
    if (typeof line !== 'string' || line.length > 20_000) throw new Error('invalid command line');
    enforceRate('cli-run', 10, 5); // 10-burst, 5/sec sustained
    return runFromApp(line);
  });
  ipcMain.handle(IPC.CLI_OPEN_POWERSHELL, async () => {
    const state = getCliState();
    if (state.status === 'off') {
      return { ok: false, error: 'CLI server is not running. Start it first.' };
    }
    if (process.platform !== 'win32') {
      return {
        ok: false,
        error:
          'Open in PowerShell is Windows-only. On macOS / Linux, run: node ./bin/sentinel-node-manager.js',
      };
    }
    try {
      const binDir = path.join(app.getAppPath(), 'bin');
      const script = path.join(binDir, 'sentinel-node-manager.js');
      // `cmd /c start` is the canonical way to spawn a new visible console
      // window from a GUI process on Windows. `spawn(powershell, …, { detached })`
      // alone doesn't get a console — the window never appears. The empty
      // string after `start` is the window title (required when the next
      // arg is quoted).
      const psCmd = `Write-Host 'Sentinel Node Manager CLI — type help'; node "${script.replace(/"/g, '`"')}"`;
      const child = spawn(
        'cmd.exe',
        [
          '/c',
          'start',
          '""',
          'powershell.exe',
          '-NoProfile',
          '-NoLogo',
          '-NoExit',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          psCmd,
        ],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        },
      );
      child.on('error', (err) => log.warn('cli powershell spawn error', { err: String(err) }));
      child.unref();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: toUserError(err, 'cli-open-powershell') };
    }
  });

  // -- Diagnostics / online ---------------------------------------------------
  ipcMain.handle(IPC.SYSTEM_ONLINE, () => true); // Renderer-side probe is more meaningful
  ipcMain.handle(IPC.SYSTEM_DIAGNOSTICS, async () => {
    const { filePath } = await dialog.showSaveDialog({
      title: 'Export diagnostics',
      defaultPath: `sentinel-dvpn-diagnostics-${new Date().toISOString().split('T')[0]}.zip`,
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
    if (!filePath) return { ok: false, cancelled: true };
    await writeDiagnosticsZip(filePath);
    shell.showItemInFolder(filePath);
    return { ok: true, path: filePath };
  });
}

async function exportNodeLogs(req: NodeLogExportRequest): Promise<NodeLogExportResult> {
  try {
    if (!req || typeof req !== 'object') throw new Error('Invalid log export request');
    vUUID(req.nodeId, 'node id');
    if (!['txt', 'log', 'json'].includes(req.format)) throw new Error('Invalid export format');
    if (!Array.isArray(req.lines)) throw new Error('Invalid log lines');
    const node = await getNode(req.nodeId);
    const moniker = node?.moniker?.replace(/[^A-Za-z0-9_.-]/g, '_') ?? req.nodeId;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = req.format === 'json' ? 'json' : req.format === 'log' ? 'log' : 'txt';
    const filters =
      req.format === 'json'
        ? [{ name: 'JSON', extensions: ['json'] }]
        : req.format === 'log'
          ? [{ name: 'Log file', extensions: ['log'] }]
          : [{ name: 'Plain text', extensions: ['txt'] }];
    const { filePath, canceled } = await dialog.showSaveDialog({
      title: 'Export container logs',
      defaultPath: `${moniker}-logs-${stamp}.${ext}`,
      filters,
    });
    if (canceled || !filePath) return { ok: false, cancelled: true };
    await fs.writeFile(filePath, renderLogExport({ ...req, lines: req.lines.map(String) }, node?.moniker ?? null), 'utf8');
    shell.showItemInFolder(filePath);
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: toUserError(err, 'export-node-logs') };
  }
}
