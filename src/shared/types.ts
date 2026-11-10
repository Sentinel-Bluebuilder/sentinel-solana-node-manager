/**
 * Types shared between the Electron main process, the preload bridge,
 * and the React renderer. Nothing in this file should import Node/Electron
 * or DOM APIs so it can be safely consumed by either side.
 */

export type NodeStatus = 'online' | 'offline' | 'loading' | 'error';

export type NodeDeployTarget = 'local' | 'remote';

/** The six tunnel protocols the Solana dvpn program advertises as a bitmask. */
export type VpnServiceType = 'wireguard' | 'amneziawg' | 'v2ray' | 'xray' | 'openvpn' | 'hysteria2';

/**
 * The Solana dvpn program has no price oracle: prices are flat base units
 * (6 decimals). `'flat'` is the only mode; the type is kept so old records
 * and the USD input helper still type-check.
 */
export type PriceMode = 'flat';

/**
 * Stages of removing a node. Each is idempotent and persisted so a removal
 * interrupted by an app restart resumes where it stopped.
 *   redeem → stop → delist → close (bond to unbonding) → unbonding (wait
 *   `unbondsAt`) → withdraw-bond → sweep (node key funds back to the wallet)
 */
export type RemovalStage =
  | 'redeem'
  | 'stop'
  | 'delist'
  | 'close'
  | 'unbonding'
  | 'withdraw-bond'
  | 'sweep'
  | 'done';

/**
 * Hardware snapshot captured at deploy time and published on-chain as an
 * SPL Memo signed by the node key (`specs:v1:{…}`). Operator-reported, NOT
 * consensus-validated.
 *
 * Compact field names keep the memo small.
 *   cpu  – cpu model (truncated to 64 chars)
 *   c    – total logical host cores
 *   cr   – cores available to the dvpn-node container (Docker/WSL2 VM view)
 *   r    – total host RAM (MiB)
 *   rr   – RAM available to the dvpn-node container (Docker/WSL2 VM, MiB)
 *
 * `cr`/`rr` are "available to the container", not "reserved": the node
 * container runs uncapped (no HostConfig Memory/NanoCpus), so these report the
 * Docker engine's ceiling (on Windows = the WSL2 VM allocation, which is below
 * the host total). See node-specs.ts for the full rationale.
 */
export interface NodeSpecsSnapshot {
  cpu: string;
  c: number;
  cr: number;
  r: number;
  rr: number;
}

export interface DeployedNode {
  id: string;
  name: string;
  moniker: string;
  target: NodeDeployTarget;
  host?: string;
  region?: string;
  /** ISO-3166-1 alpha-2 country code resolved via geoip (e.g. 'US', 'DE'). */
  country?: string;
  /** Human-readable country name matching `country` (e.g. 'United States'). */
  countryName?: string;
  status: NodeStatus;
  createdAt: string;
  /**
   * The node key (base58). It is the node's on-chain OWNER: it signs
   * open_node, holds the bond and receives revenue. The daemon signs with it.
   */
  operatorAddress: string;
  /** Last observed tDVPN balance of the node key's token account. */
  balanceDVPN: number;
  /** Last observed SOL balance of the node key (fees + rent). */
  balanceSOL?: number;
  /** API port = first port of the node's block (`port`..`port+4`). */
  port: number;
  /** 32-byte hex node id written by `dvpnd init` and passed to open_node. */
  chainNodeId?: string;
  /** Node PDA `["node", owner, node_id]`. */
  nodePda?: string;
  /** SHA-256 of the node's TLS certificate (clients pin it). */
  tlsSha256?: string;
  /** Per-lease hourly price (display units). Solana has three node prices. */
  leaseHourlyPriceDVPN?: number;
  /** Signature of the open_node transaction. */
  openTx?: string;
  /** Present while a removal is in flight. */
  removalStage?: RemovalStage;
  /** ISO time the bond can be withdrawn (close_node + unbonding period). */
  unbondsAt?: string;
  /** Unbonding PDA `["node_unbonding", owner, node_id]`. */
  unbondingPda?: string;
  /** Hardware snapshot captured at deploy time. Populated for new launches. */
  specs?: NodeSpecsSnapshot;
  /** Signature of the memo transaction that published `specs`. */
  specsTxHash?: string;
  /** Unix ms when `specsTxHash` was confirmed. */
  specsPublishedAt?: number;
  /** True between deploy success and successful spec broadcast. Cleared on success. */
  specsPublishPending?: boolean;
  /** Channel prices (display tDVPN units): per GB and per hour. */
  gigabytePriceDVPN: number;
  hourlyPriceDVPN: number;
  priceMode?: PriceMode;
  usdGigabytePrice?: number;
  usdHourlyPrice?: number;
  serviceType: VpnServiceType;
  /** Docker container id (local) OR container name (remote). */
  runtimeId?: string;
  /** Node image tag the node was deployed with (absent = deployed before the source was part of the tag). */
  imageTag?: string;
  /** SSH port / user used at deploy (non-secret) so Reconnect can offer them again. */
  sshPort?: number;
  sshUser?: string;
  /** The app opened the node's port block in the host firewall (ufw) at deploy; closed again at removal. */
  firewallOpened?: boolean;
  /**
   * Host cleanup (ufw rules + node home) that removal could not finish, usually because
   * the SSH credentials were gone by then. Chain and funds are already settled; only the
   * remote box still holds our leftovers. Kept so Reconnect can finish the job — without
   * it the record is dropped and the leftovers become unreachable orphans.
   */
  pendingHostCleanup?: {
    /** Why it could not run (shown to the user). */
    reason: string;
    /** Unix ms of the last attempt. */
    at: number;
    /** Port block to remove from the host firewall, when the app opened it. */
    ports?: number[];
  };
  /** True once open_node landed on chain. */
  registeredOnChain: boolean;
  /** Publicly reachable URL of the node's API (for wallet clients). */
  remoteUrl?: string;
  /** ISO timestamp of when the node process most recently started (persisted). */
  startedAt?: string;
}

export interface UpdateNodePricingRequest {
  nodeId: string;
  /** Display tDVPN units. All three are sent together (program rule). */
  gigabytePriceDVPN: number;
  hourlyPriceDVPN: number;
  leaseHourlyPriceDVPN?: number;
  priceMode?: PriceMode;
  usdGigabytePrice?: number;
  usdHourlyPrice?: number;
}

export interface SetProtocolRequest {
  nodeId: string;
  serviceType: VpnServiceType;
}

export interface WalletState {
  address: string | null;
  /** tDVPN (display units). */
  balanceDVPN: number;
  balanceSOL?: number;
  createdAt: string | null;
  /** True if an encrypted secret (mnemonic or key file) exists on disk. */
  hasMnemonic: boolean;
  /** How the wallet was created: a 24-word phrase, or an imported key file. */
  secretKind?: 'mnemonic' | 'keyfile';
}

/** Result of the in-app "Test node" paid session. */
export interface NodeTestResult {
  ok: boolean;
  nodeId: string;
  serviceType: VpnServiceType;
  /** Voucher channel opened by the app wallet for this test. */
  channel?: string;
  sessionId?: string;
  /** Bytes fetched through the tunnel by curl. */
  downloadedBytes?: number;
  /** Bytes the client daemon metered (rx+tx). */
  clientBytes?: number;
  /** Node revenue (base units) before / after the test redemption. */
  revenueBefore?: number;
  revenueAfter?: number;
  durationMs: number;
  /** Human-readable step log. */
  steps: string[];
  error?: string;
  /** Client daemon log tail (diagnostics on failure). */
  clientLog?: string;
  /** Set when the client cannot run on this host (kernel capability), not a node defect. */
  unsupported?: string;
  /** Where the paying client ran: on the node's host (hairpin allowed) or on this machine (a real outside client). */
  clientOn?: 'host' | 'here';
  /** True when the client reached the node's public URI directly (no hairpin). */
  directReach?: boolean;
  /**
   * Set (instead of opening a channel) when this machine cannot reach the node's
   * public URI while the node answers on its own host: the block is upstream of
   * the host (provider / cloud firewall), which the app cannot change.
   */
  blockedUpstream?: string;
}

export interface NodeLiveStatus {
  nodeId: string;
  reachable: boolean;
  /** Sessions the daemon is serving right now. */
  sessions: number;
  bytesOut: number;
  bytesIn: number;
  /** Uptime (ms) of the node process, persisted across app restarts. */
  uptimeMs: number;
  /** Current Solana slot (replaces Cosmos block height). */
  chainHeight?: number;
  /** Probe latency from the app to the on-chain data source. */
  apiLatencyMs?: number;
  /** Tail of the container / node logs (~last 200 lines). */
  logTail: string[];
  /** On-chain listing status: `listed` | `delisted` | `not-found`. */
  chainStatus?: string;
  /** Node PDA. */
  chainAddress?: string;
  /** ISO time of the last list/heartbeat (`listedAt`). */
  lastStatusAt?: string;
  /** ISO time the listing drops out of discovery unless re-listed. */
  listingExpiresAt?: string;
  /** Unredeemed-to-wallet revenue held for the node on chain (display tDVPN). */
  revenueDVPN?: number;
  /** Fees accrued to the protocol, swept by the daemon (display tDVPN). */
  feesAccruedDVPN?: number;
  /** Protocol bitmask as stored on chain. */
  protocolBits?: number;
  /** Prices as stored on chain (display tDVPN). */
  chainPrices?: { perGb: number; perHour: number; leasePerHour: number };
  /** URI as stored on chain. */
  chainUri?: string;
  /** Live sessions served by the daemon. */
  activeSubscriptions: NodeSession[];
  /** Leases (provider pre-paid positions) on this node. */
  linkedPlans: NodePlanLink[];
  /** Null when everything is fine. */
  error?: string;
}

/**
 * Push payload from main → renderer whenever a node's live status is
 * resampled (fast-poll while a node is registering, or the regular 60s
 * sweep). Lets the renderer keep `liveStatuses` fresh without polling.
 */
export interface NodeLiveStatusUpdate {
  nodeId: string;
  status: NodeLiveStatus;
}

/** A lease on this node: a provider pre-paying the node per hour. */
export interface NodePlanLink {
  /** Lease account address. */
  id: string;
  /** Token symbol (`tDVPN`). */
  denom: string;
  /** Escrow remaining in the lease (display units). */
  price: number;
  /** Days since the lease opened. */
  durationDays: number;
  /** Provider that opened the lease (base58), when known. */
  provider?: string;
  /** Daemon-side status (open / closing / closed) or on-chain status code. */
  status?: string;
}

export interface NodeSession {
  id: string;
  subscriber: string;
  subscriberShort: string;
  bytesIn: number;
  bytesOut: number;
  durationSeconds: number;
  status?: string;
}

export interface SSHCredentials {
  host: string;
  port: number;
  username: string;
  /** Exactly one of password / privateKey is required. */
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface SSHTestResult {
  ok: boolean;
  message: string;
  osInfo?: string;
  latencyMs?: number;
}

export type DeployPhase =
  | 'connecting'
  | 'preflight'
  | 'docker-check'
  | 'image-build'
  | 'fund'
  | 'keygen'
  | 'configure'
  | 'starting'
  | 'verifying'
  | 'done'
  | 'error'
  | 'cancelled';

export interface DeployProgress {
  jobId: string;
  nodeId: string;
  phase: DeployPhase;
  percent: number;
  message: string;
  log: string;
  /** Populated on the keygen phase so the UI can prompt the user to write it down. */
  mnemonicForBackup?: string;
  operatorAddress?: string;
  /** Signature of the most recent transaction this phase sent (explorer link). */
  txSig?: string;
}

export type DockerUnreachableReason =
  | 'desktop-not-installed'
  | 'desktop-not-running'
  | 'engine-not-running';

export interface DockerDesktopStatus {
  /** Docker Desktop is installed on disk (Windows/macOS). Always false on Linux. */
  installed: boolean;
  launchPath?: string;
  /** True if we can start it from the app (Windows/macOS only). */
  startable: boolean;
}

export interface SentinelContainerSummary {
  id: string;
  name: string;
  state: string;
  status: string;
  image: string;
  createdUnix: number;
}

export interface SentinelImageSummary {
  id: string;
  tag: string;
  sizeBytes: number;
  createdUnix: number;
}

export interface DockerOverview {
  reachable: boolean;
  version?: string;
  apiVersion?: string;
  os?: string;
  arch?: string;
  kernel?: string;
  serverTime?: string;
  totalMemoryMb?: number;
  ncpu?: number;
  rootDir?: string;
  containers: { total: number; running: number; paused: number; stopped: number };
  images: { count: number; sizeBytes: number };
  sentinelContainers: SentinelContainerSummary[];
  sentinelImages: SentinelImageSummary[];
  desktop?: DockerDesktopStatus;
  error?: string;
  reason?: DockerUnreachableReason;
}

export interface LocalSystemReport {
  osCompatible: boolean;
  osLabel: string;
  /** 'win32' | 'darwin' | 'linux' | other — surfaced verbatim from `os.platform()`. */
  platform: string;
  /** 'x64' | 'arm64' | etc. */
  arch: string;
  memoryMb: number;
  memoryOk: boolean;
  /** Free RAM at probe time. Snapshot, not a live reading. */
  freeMemoryMb: number;
  /** Reported by `os.cpus()[0].model`. */
  cpuModel: string;
  /** Logical core count. */
  cpuCores: number;
  /** Reported max clock; some VMs report 0 — UI should hide when falsy. */
  cpuSpeedMhz: number;
  diskFreeGb: number;
  diskOk: boolean;
  dockerInstalled: boolean;
  dockerVersion?: string;
  dockerReachable: boolean;
  dockerError?: string;
  /** Why the daemon isn't reachable, if !dockerReachable. Lets UI show the right recovery action. */
  dockerReason?: DockerUnreachableReason;
  /** Install / launch state for Docker Desktop, if applicable. */
  dockerDesktop?: DockerDesktopStatus;
  /**
   * True when the host is Windows AND Docker Desktop is using the WSL2
   * backend (most installs). Lets the UI surface the `vmmemwsl` /
   * `.wslconfig` tuning callout.
   */
  wsl2Backend: boolean;
  /**
   * CQAP (capacity-measurement on-node software) detection.
   *   • 'enabled'  — running and reachable.
   *   • 'disabled' — explicitly off / not installed.
   *   • 'unknown'  — detection mechanism not yet wired up; UI shows a
   *     placeholder pending product decision on how to detect.
   */
  cqap: 'enabled' | 'disabled' | 'unknown';
  /** Optional one-line context for the CQAP chip ("Detection coming soon", "Sidecar not running", etc.). */
  cqapDetail?: string;
}

/**
 * Live system telemetry sample pushed from main → renderer at ~1 Hz while
 * the user has the System page's "Live Specs" toggle enabled. The renderer
 * subscribes by calling `system.startLiveStats()` and unsubscribes via
 * `system.stopLiveStats()`; the main process refcounts subscriptions so
 * multiple windows can share one timer.
 */
export interface LiveSystemStats {
  /** Unix ms when the sample was taken. */
  ts: number;
  /** Free RAM in MB at sample time. */
  freeMemoryMb: number;
  /** Used RAM in MB (totalMb - freeMb). */
  usedMemoryMb: number;
  /** Total RAM in MB. Repeated each tick so the renderer can render without the static report. */
  totalMemoryMb: number;
  /** CPU load 0-100 averaged across all cores since the last sample. */
  cpuLoadPct: number;
  /** Per-core CPU load 0-100 since the last sample. Length = logical core count. */
  cpuPerCorePct: number[];
}

export interface DeployRequest {
  target: NodeDeployTarget;
  moniker: string;
  /** Channel price per GB (display tDVPN). */
  gigabytePriceDVPN: number;
  /** Channel price per hour (display tDVPN). */
  hourlyPriceDVPN: number;
  /** Lease price per hour (display tDVPN). Defaults to `hourlyPriceDVPN`. */
  leaseHourlyPriceDVPN?: number;
  priceMode?: PriceMode;
  usdGigabytePrice?: number;
  usdHourlyPrice?: number;
  serviceType: VpnServiceType;
  /** First port of the node's 5-port block (api = port, service = port+1..). */
  port: number;
  /** Public host (IP or DNS) clients dial. Defaults to the LAN IP / SSH host. */
  remoteUrl?: string;
  /** Two-letter country code put on chain. Defaults to geoip of the host. */
  country?: string;
  /** Required when target === 'remote'. */
  ssh?: SSHCredentials;
}

export type EventKind =
  | 'wallet-created'
  | 'wallet-restored'
  | 'wallet-logout'
  | 'deploy-started'
  | 'deploy-succeeded'
  | 'deploy-failed'
  | 'node-started'
  | 'node-stopped'
  | 'node-restarted'
  | 'node-removed'
  | 'node-unreachable'
  | 'node-online'
  | 'node-registered'
  | 'specs-reported'
  | 'specs-publish-failed'
  | 'withdraw-sent'
  | 'withdraw-failed'
  | 'balance-refreshed'
  | 'node-repriced'
  | 'node-protocol-changed'
  | 'node-redeemed'
  | 'node-delisted'
  | 'node-closed'
  | 'bond-withdrawn'
  | 'funds-swept'
  | 'node-test-passed'
  | 'node-test-failed';

export interface AppEvent {
  id: string;
  kind: EventKind;
  title: string;
  subtitle: string;
  timestamp: string;
  amountDVPN?: number;
  relatedNodeId?: string;
  txHash?: string;
}

export interface SendTxRequest {
  to: string;
  /** tDVPN (display units). 0 allowed when `amountSOL` is set. */
  amountDVPN: number;
  /** Optional SOL to send in the same transaction. */
  amountSOL?: number;
  memo?: string;
}

export interface NodeWithdrawRequest {
  nodeId: string;
  /** Defaults to the app wallet's own address. */
  to?: string;
  /** If omitted, the full node balance minus gas is withdrawn. */
  amountDVPN?: number;
}

export interface SendTxResult {
  ok: boolean;
  /** Transaction signature (base58). */
  txHash?: string;
  /** Slot the transaction landed in. */
  height?: number;
  /** Fee paid, in lamports. */
  gasUsed?: number;
  error?: string;
  /** Classified error code so the UI can show a helpful message. */
  errorCode?:
    | 'insufficient-funds'
    | 'invalid-amount'
    | 'invalid-address'
    | 'timeout'
    | 'rpc-unavailable'
    | 'chain-mismatch'
    | 'gas-estimation-failed'
    | 'program-error'
    | 'unknown';
}

export interface ChainHealth {
  rpcUrl: string;
  reachable: boolean;
  latencyMs?: number;
  /** `devnet` when the genesis hash matches; otherwise the hash itself. */
  chainId?: string;
  /** Current slot. */
  blockHeight?: number;
  error?: string;
}

export type NodeImageSource = 'prebuilt' | 'source';
export const NODE_IMAGE_SOURCES: readonly NodeImageSource[] = ['prebuilt', 'source'];

export interface AppSettings {
  /** Solana JSON-RPC URLs, tried in order. */
  rpcUrls: string[];
  /** Compute-unit price added to every app-sent transaction. 0 = none. */
  priorityFeeMicroLamports: number;
  /**
   * Where the node image comes from. `prebuilt` (default): the release's checksum-pinned
   * image file is downloaded and loaded into Docker — no source, no build. `source`: built
   * from the sentinel-solana tree in `upstreamDir` (developers).
   */
  nodeImageSource: NodeImageSource;
  /** sentinel-solana source tree used as the node image build context (source mode only). */
  upstreamDir: string;
  /** Explicit override — if blank the app probes the Docker daemon. */
  dockerSocket: string;
  /** Cosmetic toggle only; persisted across launches. */
  seenOnboarding: boolean;
  /**
   * When true, closing the window hides it to the system tray instead of
   * quitting. The user explicitly picks "Quit" from the tray to exit.
   * Containers are never touched by close/hide — they follow their own
   * lifecycle so earnings aren't interrupted when the dashboard is closed.
   */
  minimizeToTrayOnClose: boolean;
  /**
   * When true, picking "Quit" from the tray menu also docker-stops every
   * running node before exiting. Off by default because most operators
   * want the node to keep earning even when the manager isn't running.
   */
  stopNodesOnQuit: boolean;
  /**
   * One-time flag — set to true once we've shown the "still running in
   * the tray" toast, so we don't nag the user every close.
   */
  trayHintShown: boolean;
  /**
   * When true, stops the local CLI server when the app quits. When false,
   * the server keeps running so already-connected PowerShell / agent
   * sessions aren't yanked out from under the user.
   */
  stopCliServerOnQuit: boolean;
  /**
   * How often (seconds) the main process re-queries the chain for the
   * app wallet's DVPN balance. Lower = fresher numbers, more RPC traffic.
   * Clamped to [10, 600] at the service layer.
   */
  walletRefreshIntervalSec: number;
  /**
   * How often (seconds) the main process samples each deployed node's
   * on-chain status (sessions, earnings, reachability) and pushes the
   * update to the renderer. Clamped to [15, 600].
   */
  nodeRefreshIntervalSec: number;
}

export interface MetricsSample {
  nodeId: string;
  ts: number; // unix ms
  peers: number;
  bytesIn: number;
  bytesOut: number;
  /** Node revenue on chain, base units. */
  earningsUdvpn: number;
  /** Solana slot. */
  chainHeight?: number;
  reachable: boolean;
}

export type MetricsWindow = '1h' | '24h' | '7d' | '30d';

export interface DiagnosticsArtifact {
  path: string;
  sizeBytes: number;
}

export type NodeLogExportFormat = 'txt' | 'json' | 'log';

export interface NodeLogExportRequest {
  nodeId: string;
  format: NodeLogExportFormat;
  /** Raw log lines captured by the renderer (ANSI-stripped by the writer). */
  lines: string[];
}

export interface NodeLogExportResult {
  ok: boolean;
  path?: string;
  cancelled?: boolean;
  error?: string;
}

export interface MnemonicExportResult {
  ok: boolean;
  path?: string;
  cancelled?: boolean;
  error?: string;
}

/** Channel names used for all renderer <-> main IPC. */
export const IPC = {
  // System / environment
  SYSTEM_REPORT: 'system:report',
  SYSTEM_ONLINE: 'system:online',
  SYSTEM_DIAGNOSTICS: 'system:diagnostics',
  SYSTEM_LIVE_STATS_START: 'system:live-stats-start',
  SYSTEM_LIVE_STATS_STOP: 'system:live-stats-stop',
  SYSTEM_LIVE_STATS: 'system:live-stats', // main -> renderer push (~1 Hz)
  DOCKER_START: 'docker:start',
  DOCKER_OVERVIEW: 'docker:overview',
  DOCKER_QUIT: 'docker:quit',
  DOCKER_FORCE_QUIT: 'docker:force-quit',
  DOCKER_STOP_ALL_SENTINEL: 'docker:stop-all-sentinel',
  DOCKER_PRUNE: 'docker:prune',
  DOCKER_OPEN_SETTINGS: 'docker:open-settings',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  CHAIN_HEALTH: 'chain:health',

  // Wallet
  WALLET_GET: 'wallet:get',
  WALLET_CREATE: 'wallet:create',
  WALLET_RESTORE: 'wallet:restore',
  WALLET_REFRESH_BALANCE: 'wallet:refresh-balance',
  WALLET_SEND: 'wallet:send',
  WALLET_QR: 'wallet:qr',
  WALLET_LOGOUT: 'wallet:logout',
  WALLET_IMPORT_KEY: 'wallet:import-key',
  WALLET_CHANGED: 'wallet:changed', // main -> renderer push (balance refreshed / wallet replaced)

  // Events
  EVENTS_LIST: 'events:list',
  EVENTS_CHANGED: 'events:changed', // main -> renderer push

  // SSH helpers for remote deploy
  SSH_TEST: 'ssh:test',
  SSH_FORGET_HOST_KEY: 'ssh:forget-host-key',

  // Deploy lifecycle
  DEPLOY_START: 'deploy:start',
  DEPLOY_CANCEL: 'deploy:cancel',
  DEPLOY_STATUS: 'deploy:status',
  DEPLOY_PROGRESS: 'deploy:progress', // main -> renderer push

  // Node management
  NODES_LIST: 'nodes:list',
  NODES_GET: 'nodes:get',
  NODES_RESTART: 'nodes:restart',
  NODES_STOP: 'nodes:stop',
  NODES_START: 'nodes:start',
  NODES_REMOVE: 'nodes:remove',
  NODES_LOGS: 'nodes:logs',
  NODES_EXPORT_LOGS: 'nodes:export-logs',
  NODES_STATUS: 'nodes:status',
  NODES_HISTORY: 'nodes:history',
  NODES_WITHDRAW: 'nodes:withdraw',
  NODES_BACKUP_MNEMONIC: 'nodes:backup-mnemonic',
  NODES_EXPORT_MNEMONIC: 'nodes:export-mnemonic',
  NODES_REVEAL_MNEMONIC: 'nodes:reveal-mnemonic',
  NODES_UPDATE_PRICING: 'nodes:update-pricing',
  NODES_PUBLISH_SPECS: 'nodes:publish-specs',
  NODES_REAP_STUCK: 'nodes:reap-stuck',
  NODES_SET_PROTOCOL: 'nodes:set-protocol',
  NODES_REDEEM: 'nodes:redeem',
  NODES_RELIST: 'nodes:relist',
  NODES_WITHDRAW_BOND: 'nodes:withdraw-bond',
  NODES_FORGET_SERVER: 'nodes:forget-server',
  NODES_TEST: 'nodes:test',
  NODES_SWEEP_TEST_CHANNELS: 'nodes:sweep-test-channels',
  NODES_SESSIONS: 'nodes:sessions',
  NODES_CLOSE_SESSION: 'nodes:close-session',
  NODES_POSITIONS: 'nodes:positions',
  NODES_REDEMPTIONS: 'nodes:redemptions',
  NODES_INSPECT: 'nodes:inspect',
  NODES_DAEMON: 'nodes:daemon',
  PROGRAM_STATUS: 'program:status',
  NODES_RECONNECT: 'nodes:reconnect',
  NODES_SSH_STATUS: 'nodes:ssh-status',
  NODES_LEASES: 'nodes:leases',
  NODES_CHANGED: 'nodes:changed', // main -> renderer push
  NODES_LIVE_STATUS: 'nodes:live-status', // main -> renderer push (per-node)

  // CLI server (local pipe / unix socket)
  CLI_STATUS: 'cli:status',
  CLI_START: 'cli:start',
  CLI_STOP: 'cli:stop',
  CLI_RUN: 'cli:run',
  CLI_COMMANDS: 'cli:commands',
  CLI_EXEC: 'cli:exec',
  CLI_OPEN_POWERSHELL: 'cli:open-powershell',
  CLI_STATE_CHANGED: 'cli:state-changed', // main -> renderer push
  CLI_STREAM: 'cli:stream', // main -> renderer push
} as const;

export type IPCChannel = (typeof IPC)[keyof typeof IPC];

/** Who currently holds the single-active-client lock on the CLI server. */
export type CliClientKind = 'app' | 'shell' | 'agent';

export type CliServerStatus = 'off' | 'app-active' | 'shell-active' | 'agent-active';

export interface CliServerState {
  status: CliServerStatus;
  /** Filesystem path to the named pipe / unix socket, when running. */
  endpoint: string | null;
  /** When the active session was opened (ISO). */
  sessionStartedAt: string | null;
  /** Path to the discovery file the binary reads to find the endpoint. */
  discoveryPath: string | null;
  /** Last error from the server (start failure, etc.). */
  error: string | null;
}

/**
 * Stream events broadcast to the in-app CLI screen. Mirrors what an
 * external PowerShell / agent client sees on stdout.
 */
export interface CliStreamEvent {
  /** Monotonic per-session id so clients can dedupe. */
  seq: number;
  /** ISO timestamp. */
  ts: string;
  /** Originating client. `system` is the server itself (state changes). */
  source: CliClientKind | 'system';
  /** What the line represents. */
  kind: 'input' | 'ok' | 'err' | 'info';
  /** Already-formatted text. JSON is pretty-printed before broadcast. */
  text: string;
}

export interface CliRunRequest {
  /** Raw command line, e.g. `nodes.history abc --window 1h`. */
  line: string;
}

export interface CliRunResult {
  ok: boolean;
  /** Pretty-printed response text. Empty when ok===false. */
  text: string;
  error?: string;
}
