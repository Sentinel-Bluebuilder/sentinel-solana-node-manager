import type { NodeDeployTarget, NodeStatus, RemovalStage, SSHCredentials } from '../../shared/types';
import type { ParsedArgs } from './cli-args';

/**
 * Payload validation shared by the IPC handlers and the CLI registry, so both
 * entries accept exactly the same inputs. Every function throws on bad input.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// IPv4, hostnames and bracket-less IPv6 (ssh2 takes the literal); no spaces, slashes or quotes.
const HOSTNAME_RE = /^[a-zA-Z0-9.\-:_]{1,255}$/;
const USERNAME_RE = /^[a-zA-Z0-9._\-]{1,32}$/;

export function vUUID(id: unknown, label: string): string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new Error(`Invalid ${label}: expected UUID`);
  return id;
}

export function validateHostPort(hostRaw: unknown, portRaw: unknown): { host: string; port: number } {
  const host = String(hostRaw ?? '').trim();
  if (!HOSTNAME_RE.test(host)) throw new Error('Invalid SSH host');
  const port = Number(portRaw ?? 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SSH port');
  return { host, port };
}

export function validateSSHCredentials(raw: unknown): SSHCredentials {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid SSH credentials');
  const c = raw as Record<string, unknown>;
  const { host, port } = validateHostPort(c.host, c.port);
  const username = String(c.username ?? '');
  if (!USERNAME_RE.test(username)) throw new Error('Invalid SSH username');
  const cap = (s: unknown, max: number): string | undefined => {
    if (s === undefined || s === null) return undefined;
    const v = String(s);
    if (v.length > max) throw new Error('SSH credential field too long');
    return v;
  };
  const creds: SSHCredentials = {
    host,
    port,
    username,
    password: cap(c.password, 4096),
    privateKey: cap(c.privateKey, 32_768),
    passphrase: cap(c.passphrase, 4096),
  };
  if (!creds.password && !creds.privateKey?.trim()) throw new Error('SSH credentials need a private key or a password');
  return creds;
}

/** events.list limit: 1..1000, floored; undefined → default. */
export function clampEventLimit(limit: unknown): number | undefined {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return undefined;
  return Math.min(Math.floor(limit), 1000);
}

/** Node id from positional `idx` (or `--flag` when given / idx < 0), UUID-validated. */
export function requireNodeId(p: ParsedArgs, idx: number, flag?: string): string {
  const pos = idx >= 0 ? p.positional[idx] : undefined;
  const f = flag ? p.flags[flag] : undefined;
  const v = pos ?? (typeof f === 'string' ? f : undefined);
  if (!v) throw new Error(flag ? `Missing node id (pass it positionally or as --${flag})` : 'Missing positional argument: nodeId');
  return vUUID(v, 'node id');
}

/**
 * A node reference from positional `idx`: this app's node id or an on-chain node
 * address. Only presence is checked here; resolveNodeRef (node-ref.ts) validates
 * the form and finds the record.
 */
export function requireNodeRef(p: ParsedArgs, idx: number, name: string): string {
  const v = p.positional[idx]?.trim();
  if (!v) throw new Error(`Missing positional argument: ${name}`);
  return v;
}

/**
 * True when a failed host cleanup leaves our firewall rules and node directory on a
 * machine the app must come back to over SSH. The node record is the only place that
 * knows those leftovers are ours, so for these targets the record must be kept
 * (removal parks at 'sweep') instead of being dropped and orphaning them.
 *
 * Deliberately a named predicate over `NodeDeployTarget`: an inline
 * `target !== 'ssh'` typechecked happily against the `'local' | 'remote'` union and
 * silently took the wrong branch for every remote node.
 */
export function hostCleanupMustBeRetried(target: NodeDeployTarget): boolean {
  return target === 'remote';
}

/**
 * Node-home directories the app keeps for its OWN scratch runtimes, not for nodes:
 * the outside-client test container and the wallet-level dvpnctl home. They have UUID
 * shape because the runtime requires it, they never hold a node key, and they are in
 * active use — so host-leftover cleanup must pass over them rather than report them
 * as unexplained directories on every run.
 */
export const RESERVED_RUNTIME_HOME_IDS: readonly string[] = [
  '00000000-0000-4000-8000-00000000c1e7', // node-test.ts HERE_CLIENT_ID
  '00000000-0000-4000-8000-00000000c71e', // test-channels.ts WALLET_CTL_ID
  '00000000-0000-4000-8000-00000000c71f', // test-channels.ts CHANNEL_LIST_ID
  '00000000-0000-4000-8000-00000000c7d0', // node-manager.ts READ_CTL_ID (reads of nodes this app did not deploy)
];

/**
 * Home for chain reads that belong to no node record (Q0169 by-address reads). It was the
 * string "chain-read", which every runtime refuses (node homes must be UUIDs), so those
 * reads could never run in the app.
 */
export const READ_CTL_HOME_ID: string = RESERVED_RUNTIME_HOME_IDS[3];

/**
 * Where a node's own chain commands (dvpnctl: status, protocol, pricing, withdraw, removal)
 * run. A remote node's host already holds its image and its key, so they run THERE when it
 * answers over SSH and has the image. They used to always run on this computer's Docker, so
 * managing a VPS node from a machine without Docker (or without buildx) failed every call
 * (FLX2, after Q0394). This computer stays the fallback: an unreachable host (e.g. an IP that
 * changed, Q0328) or one that lost the image.
 */
/**
 * Timeout message of waitForChain. When every chain read FAILED (vs. read fine but showed the old
 * value) the message must say so and carry the read error: it used to say only "the chain does
 * not show X", hiding e.g. the missing-buildx error behind a 180 s timeout (FLX2, Q0407).
 */
export function chainWaitTimeoutMessage(what: string, timeoutMs: number, lastReadError?: string): string {
  const secs = Math.round(timeoutMs / 1000);
  if (lastReadError) {
    return `The daemon restarted, but the chain could not be read for ${secs}s to confirm ${what}: ${lastReadError.trim().slice(0, 400)}`;
  }
  return `The daemon restarted but the chain does not show ${what} after ${secs}s. Check the node logs.`;
}

/**
 * A remote node's chain command fell back to this computer and failed there too. Lead with
 * the fix the user can act on (reconnect to the server) instead of only the local error,
 * e.g. "buildx missing on this computer" after an app restart dropped the SSH link (Q0409).
 */
export function remoteFallbackError(host: string, why: string, localError: string): string {
  return (
    `This node's chain commands run on its server ${host}, but ${why}. Reconnect to it ` +
    `(Nodes → node → Reconnect), then try again. Running them on this computer instead failed: ${localError.trim().slice(0, 300)}`
  );
}

/**
 * Runs async jobs one at a time PER KEY (different keys run side by side). A node's chain
 * commands share one ctl home: each writes ctl/keys/owner.json and deletes it when done, so a
 * status poll finishing during a withdraw deleted the key under it ("reading key file: open
 * …/ctl/keys/owner.json: no such file", FLX2 uifire nodes.withdraw, Q0410).
 */
export function keyedSerial(): <T>(key: string, job: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, job: () => Promise<T>): Promise<T> => {
    const prev = tails.get(key) ?? Promise.resolve();
    const run = prev.then(job, job);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}

/**
 * The status a node may hold while it is being removed (FLX2, Q0328): never 'online'. Before
 * the stop stage has run the container may still be up, so 'loading'; from delist on the
 * container is gone, so 'offline'. Returns the requested status when no removal runs.
 */
export function statusWhileRemoving(stage: RemovalStage | undefined, want: NodeStatus): NodeStatus {
  if (!stage) return want;
  if (stage === 'redeem' || stage === 'stop') return want === 'online' ? 'loading' : want;
  return 'offline';
}

export function chainCtlPlace(o: {
  target: 'local' | 'remote';
  hasCreds: boolean;
  remoteImage: 'ready' | 'missing' | 'unreachable';
}): 'node-host' | 'this-computer' {
  if (o.target !== 'remote' || !o.hasCreds) return 'this-computer';
  return o.remoteImage === 'ready' ? 'node-host' : 'this-computer';
}

export function isReservedRuntimeHome(nodeId: string): boolean {
  return RESERVED_RUNTIME_HOME_IDS.includes(nodeId);
}

/**
 * Should a remote host cleanup that already failed be attempted again now?
 *
 * The poller waits out `retryMs`, because the usual cause (SSH credentials lost at an
 * app restart) cannot clear by itself and retrying every tick only spams. `force` is
 * the user asking for it — Reconnect, or "withdraw bond now" — and must never be made
 * to wait, because they have just supplied the thing that was missing.
 */
export function shouldRetryHostCleanup(input: {
  lastAttemptAt?: number;
  now: number;
  retryMs: number;
  force?: boolean;
}): boolean {
  if (input.force) return true;
  if (input.lastAttemptAt === undefined) return true; // never tried
  return input.now - input.lastAttemptAt >= input.retryMs;
}

/**
 * May a plain http:// RPC URL use this host? Loopback, and the private IPv4 ranges
 * (10/8, 172.16/12, 192.168/16) where a team runs its own RPC gateway inside a VPC.
 * A public host never: plaintext over the open network leaks signed TXs and queries.
 * Hostnames other than localhost are refused (they could resolve anywhere).
 * Regression (2026-11-08): the fleet's RPC gate on 10.0.0.5 was refused, so the app
 * could only reach Helius with a raw key in its settings.
 */
export function httpRpcHostAllowed(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((x) => x > 255)) return false;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * The useful part of a failed `docker build --progress=plain` log: the failing step's own output
 * (e.g. "curl: (22) ... 403"), not the Dockerfile echo BuildKit prints last. Falls back to the
 * tail. Regression (2026-11-08, a remote test host): the error ended in the RUN text and hid the cause.
 */
export function buildFailureSummary(output: string, max = 800): string {
  const lines = output.trim().split(/\r?\n/);
  const errLine = [...lines].reverse().find((l) => /^#\d+ ERROR:/.test(l));
  const step = errLine?.match(/^#(\d+) /)?.[1];
  if (!step) return output.trim().slice(-max);
  const own = lines.filter((l) => l.startsWith(`#${step} `) && !/^#\d+ (DONE|CACHED)\b/.test(l));
  const failed = lines.find((l) => /^ERROR: failed to (build|solve)/.test(l)) ?? '';
  const body = own.slice(-15).join('\n');
  return `${body}${failed ? `\n${failed.slice(0, 200)}` : ''}`.slice(-max);
}

/** Host of an RPC URL, for messages: never the path or query (they carry API keys / gateway tokens). */
export function rpcHostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch (err) {
    return `<unparseable: ${(err as Error).message}>`;
  }
}

/** Does this RPC URL point at loopback or a private network (reachable only from this side)? */
export function rpcIsLocalOnly(url: string): boolean {
  try {
    return httpRpcHostAllowed(new URL(url).hostname);
  } catch (err) {
    throw new Error(`RPC URL is not a valid URL: ${(err as Error).message}`);
  }
}

/**
 * Is this a public (internet-routable) IPv4 literal? The final client (fork-cb33-4-final)
 * refuses a node whose address is not public ("address is not public: 10.0.0.5"), so a
 * local deploy must publish the machine's public IP, not its LAN IP.
 */
export function isPublicIPv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((x) => x > 255)) return false;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  return true;
}

/**
 * Local node homes on a Linux host: the node container runs as root, so with rootful
 * Docker the files it writes into the bind-mounted home are root-owned and an app running
 * as a normal user gets EACCES on them. Only then does the app retry the operation with
 * `sudo -n`, the same way it handles a non-root SSH host. Windows/macOS (Docker Desktop
 * maps ownership) and rootless Docker never hit this, and an app running as root never
 * needs it.
 *
 * Regression (FINAL check 2026-11-08, a Linux test host): deploy failed "EACCES: permission denied,
 * scandir …/nodes/<id>/amneziawg" because local mode used plain fs calls only.
 */
export function privilegedFallbackApplies(
  err: { code?: string } | undefined,
  platform: string,
  uid: number | undefined,
): boolean {
  if (platform !== 'linux' || uid === undefined || uid === 0) return false;
  return err?.code === 'EACCES' || err?.code === 'EPERM';
}

/** One line telling a non-root Linux user how to make local nodes work. */
export function localSudoMissingError(user: string): string {
  return (
    `The node writes its files as root and "${user}" has no passwordless sudo, so the app cannot manage them. ` +
    `Fix: run \`echo '${user} ALL=(root) NOPASSWD: /usr/bin/cat, /usr/bin/install, /usr/bin/rm' | sudo tee /etc/sudoers.d/node-manager\`, ` +
    'or use rootless Docker, then retry.'
  );
}

/**
 * "The server is gone": may the app drop a node whose removal is parked on host cleanup?
 * Only once nothing is left on chain or on the key: the removal reached 'sweep', the
 * cleanup that failed is the host one, and the node key reads empty. The firewall rules
 * and node directory stay on that server; the user has said it no longer exists.
 * Returns the reason it may not, or null.
 *
 * Regression (G11, FS36 2026-11-08): the server was deleted after nodes.remove; the bond
 * came back and the key was swept, but the record stayed "Reconnect to finish" forever,
 * because Reconnect needs the server.
 */
export function forgetServerBlocker(input: {
  removalStage?: RemovalStage;
  pendingHostCleanup: boolean;
  keyEmpty: boolean;
}): string | null {
  if (!input.removalStage) return 'This node is not being removed. Remove it first; the server is only needed at the very end.';
  if (input.removalStage !== 'sweep') return `The removal is at "${input.removalStage}", not at the server-cleanup step. Let it finish the on-chain steps first.`;
  if (!input.pendingHostCleanup) return 'The server cleanup has not failed. Let the removal finish.';
  if (!input.keyEmpty) return 'The node key still holds funds. The app will not drop it until they are back in your wallet.';
  return null;
}

/** Why nodes.withdrawBond cannot run for a node at `stage` (null: it can). */
export function withdrawBondBlocker(stage: RemovalStage | undefined, pendingHostCleanup: boolean): string | null {
  if (stage === 'unbonding' || stage === 'withdraw-bond') return null;
  if (stage === 'sweep' || stage === 'done') {
    return pendingHostCleanup
      ? 'The bond is already back in your wallet and the node key is swept. Only the server cleanup is left: Reconnect, or "Server is gone" if it no longer exists.'
      : 'The bond is already back in your wallet. The removal is finishing.';
  }
  return 'This node is not unbonding yet.';
}

/**
 * After a deploy failed with money on the node key: did open_node land? `account` is a
 * direct RPC read of the node account ('unknown' = no RPC answered).
 *   exists  → 'opened': start the normal removal (delist, close, unbond, sweep).
 *   missing → 'funded': sweep the key, drop the record.
 *   unknown → 'keep':   neither guess is safe. 'opened' marks a node on chain that may
 *             never have existed and parks it in removal; 'funded' would drop the record
 *             while a bond might be in the vault. Keep the record and key for a later removal.
 * Regression (Q0322): a failed read was treated as 'opened', so an open_node that only
 * failed in simulation left registeredOnChain:true and the funding on the key.
 */
export function failedDeployVerdict(account: 'exists' | 'missing' | 'unknown'): 'opened' | 'funded' | 'keep' {
  if (account === 'exists') return 'opened';
  if (account === 'missing') return 'funded';
  return 'keep';
}

/**
 * Which local image runs a node's own dvpnctl. Chain calls always run on LOCAL Docker,
 * but a remote node's image was built on its VPS, so its tag is usually absent here.
 * Use it only when present locally; otherwise the image for the source in Settings
 * (built on demand). Regression (Q0323): the node's tag was used blindly, so every
 * removal step of a remote node failed "No such image" and retried forever.
 */
export function ctlImageChoice(input: { nodeTag?: string; nodeTagLocal: boolean; currentTag: string }): { tag: string; build: boolean } {
  if (input.nodeTag && input.nodeTagLocal) return { tag: input.nodeTag, build: false };
  return { tag: input.currentTag, build: true };
}

/**
 * First removal stage. A node never marked on chain but with a node address may still
 * hold a bond (an open_node whose landing could not be confirmed), so it goes through
 * 'delist', which reads the chain and skips straight on when there is nothing there.
 */
export function firstRemovalStage(n: { registeredOnChain?: boolean; runtimeId?: string; nodePda?: string; chainNodeId?: string }): 'redeem' | 'stop' | 'delist' | 'sweep' {
  if (n.registeredOnChain) return 'redeem';
  if (n.runtimeId) return 'stop';
  if (n.nodePda && n.chainNodeId) return 'delist';
  return 'sweep';
}

/**
 * An SSH connect error that means nothing answers at that address (not a credentials or
 * host-key problem) becomes an error that says so and names the likely cause: a server whose
 * IP address changed, which a node record cannot follow yet. Anything else is passed through.
 */
export function sshConnectError(host: string, port: number, err: Error): Error {
  if (!/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|Timed out while waiting for handshake/i.test(err.message)) return err;
  return new Error(
    `${host}:${port} does not answer over SSH (${err.message}). Check that the server is running. ` +
      `If its IP address changed, this node still points at the old address and the app cannot follow it yet: ` +
      `see README "Server IP address changed".`,
  );
}

/**
 * Should a failed SSH connect be tried again? Only when the host answered TCP but the SSH
 * handshake stalled or was reset — a slow sshd or a busy VM (Q0341: 1 of 6 protocol switches
 * failed "Timed out while waiting for handshake"). Not for an address that does not answer
 * at all (TCP timeout / unreachable / refused / DNS: retrying only delays the clear error),
 * and never for credentials or host-key failures.
 */
export const SSH_CONNECT_ATTEMPTS = 3;
export function sshConnectRetryable(message: string): boolean {
  return /Timed out while waiting for handshake|ECONNRESET|Connection lost before handshake/i.test(message);
}

/**
 * The node Dockerfile needs BuildKit (cache mounts, a RUN heredoc), and current Docker routes
 * BuildKit builds through the buildx plugin. Stock Ubuntu/Debian `docker.io` ships without it, so
 * the build used to die mid-way with "BuildKit is enabled but the buildx component is missing"
 * (Q0394). Checked with `docker buildx version` before any build; `where` = "this computer" or the host label.
 */
export function buildxMissingError(where: string, detail = ''): Error {
  const why = detail.trim() ? ` (${detail.trim().split(/\r?\n/)[0].slice(0, 200)})` : '';
  return new Error(
    `Building the node image needs Docker's buildx plugin, which is missing on ${where}${why}. ` +
      `Install it, then deploy again: Ubuntu/Debian with the docker.io package: "sudo apt install docker-buildx"; ` +
      `Docker CE: "sudo apt install docker-buildx-plugin"; Docker Desktop already includes it.`,
  );
}

/**
 * Image builds run on the HOST network (Q0405). On the default bridge (MTU 1500) a host whose
 * NIC has a smaller MTU (1450/1400 on many clouds) loses the large TLS packets, so `apk add`
 * hung until the 45-min build timeout. With host networking the build uses the NIC's own MTU.
 */
export const IMAGE_BUILD_NETWORK: readonly string[] = ['--network', 'host'];

/** A build that prints nothing for this long is stalled (a silent Go compile on 2 vCPU stays well under it). */
export const BUILD_IDLE_LIMIT_MS = 15 * 60_000;

export function buildStalledError(where: string, idleMs: number, lastLine = ''): Error {
  const last = lastLine.trim() ? ` Last output: "${lastLine.trim().slice(0, 200)}".` : '';
  return new Error(
    `The node image build on ${where} printed nothing for ${Math.round(idleMs / 60_000)} minutes and was stopped.${last} ` +
      `This is usually the network: a download (apk/go/git) that never finishes, e.g. a firewall or a ` +
      `network MTU problem on the server. Check that it can reach the internet over HTTPS, then deploy again.`,
  );
}

/** Calls onIdle once if poke() is not called for limitMs; stop() cancels it. */
export function idleWatchdog(limitMs: number, onIdle: () => void): { poke: () => void; stop: () => void } {
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      fired = true;
      onIdle();
    }, limitMs);
  };
  arm();
  return {
    poke: () => { if (!fired) arm(); },
    stop: () => { if (timer) clearTimeout(timer); },
  };
}

/** What to do with one untracked node directory found on a host. */
export type LeftoverVerdict =
  | { act: 'skip' }
  | { act: 'keep'; reason: string }
  | { act: 'delete' };

/**
 * Decide the fate of a node directory a host still holds. A directory contains the
 * node key, so deletion is allowed only when the node is provably finished with:
 * no app record claims it AND its key is empty on chain. Every other case is kept
 * and reported — never deleted on the assumption that it is probably stale.
 */
export function leftoverVerdict(input: {
  claimedByRecord: boolean;
  owner?: string;
  keyEmpty?: boolean;
  dryRun?: boolean;
}): LeftoverVerdict {
  // A live record owns its directory, whatever stage it is in.
  if (input.claimedByRecord) return { act: 'skip' };
  // Without the key owner the directory cannot be proven empty, so it stays.
  if (!input.owner) {
    return { act: 'keep', reason: 'no record of its node key — cannot prove it is empty, so it is left in place' };
  }
  if (!input.keyEmpty) return { act: 'keep', reason: 'its node key still holds value on chain' };
  if (input.dryRun) return { act: 'keep', reason: 'dry run' };
  return { act: 'delete' };
}

// ─── Shared firewall rules ───

/** The fields of a node record that decide which host firewall rules it holds. */
export interface FirewallHolder {
  id: string;
  target: NodeDeployTarget;
  host?: string;
  firewallOpened?: boolean;
}

/** Same machine: both local, or both remote on the same host. */
export function sameHost(a: FirewallHolder, b: FirewallHolder): boolean {
  if (a.target !== b.target) return false;
  return a.target !== 'remote' || (a.host ?? '') === (b.host ?? '');
}

/**
 * The ports whose firewall rule another node on the same host still holds open.
 * ufw rules are keyed by port only, so a node deployed on a port block that an older node
 * (still being removed) also used shares its rule; closing it at the old node's removal cut
 * the new node off (final4 remote run, 2026-11-08).
 */
export function portsHeldByOthers<T extends FirewallHolder>(
  node: T,
  all: T[],
  portsOf: (n: T) => number[],
): Set<number> {
  const held = new Set<number>();
  for (const other of all) {
    if (other.id === node.id || !other.firewallOpened || !sameHost(node, other)) continue;
    for (const p of portsOf(other)) held.add(p);
  }
  return held;
}
