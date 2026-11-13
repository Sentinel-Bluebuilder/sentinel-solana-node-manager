import { PublicKey } from '@solana/web3.js';
import { CTL_HOME, DAEMON_SOCKET } from './docker';
import { MINT, PROGRAM_ID } from './chain';
import { describeFailure } from './program-errors';
import { log } from './logger';
import { camelKeys, fixedText, idHex, numberField } from './ctl-json';
import { binariesFor, daemonCallArgs, translateArgs } from './cli-layout';
import { cliLayoutOf } from './cli-probe';
import type { ExecResult, NodeRuntime } from './node-runtime';

export { cliLayoutOf };

/**
 * dvpnctl, run inside the node image, is the ONLY way this app talks to the
 * dvpn program. It carries the devnet-compat patches (deployed layouts differ
 * from the source IDL) and every node instruction is proven on devnet with it.
 *
 *   ctl()        → one-shot container (`docker run --rm … dvpnctl …`) with the
 *                  node home mounted; works whether or not the node is running.
 *   ctlDaemon()  → `docker exec` into the running node, talking to the daemon's
 *                  control socket (status, sessions, redeem, heartbeat).
 *
 * The signer is CTL_HOME/keys/owner.json — the node key, which is the node's
 * on-chain owner. Output is JSON (`--output json`).
 */

export interface CtlOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
}

function baseArgs(): string[] {
  return ['--home', CTL_HOME, '--output', 'json'];
}

/** Extract the JSON document from mixed dvpnctl output (logs go to stderr). */
export function parseCtlJson<T>(output: string): T {
  const text = output.trim();
  // Some daemon commands print a bare JSON scalar (e.g. `daemon status` → "SERVING").
  if (/^("([^"\\]|\\.)*"|-?\d+(\.\d+)?|true|false|null)$/.test(text)) return JSON.parse(text) as T;
  const starts = [text.indexOf('{'), text.indexOf('[')].filter((i) => i >= 0);
  if (starts.length === 0) throw new Error(`dvpnctl returned no JSON: ${text.slice(-300)}`);
  const start = Math.min(...starts);
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  const end = text.lastIndexOf(close);
  if (end < start) throw new Error(`dvpnctl returned truncated JSON: ${text.slice(-300)}`);
  return JSON.parse(text.slice(start, end + 1)) as T;
}

function check(res: ExecResult, what: string): string {
  if (res.exitCode === -1) throw new Error(`Cancelled while ${what}.`);
  if (res.exitCode === 124) throw new Error(`Timed out while ${what}.`);
  if (res.exitCode !== 0) throw new Error(`${what} failed: ${describeFailure(res.output)}`);
  return res.output;
}

/** One-shot dvpnctl with the node home mounted. Args use the older flag names. */
export async function ctl<T>(rt: NodeRuntime, args: string[], what: string, opts: CtlOptions = {}): Promise<T> {
  const layout = await cliLayoutOf(rt, opts.signal);
  const res = await rt.runOnce([binariesFor(layout).ctl], [...baseArgs(), ...translateArgs('dvpnctl', args, layout)], {
    timeoutMs: opts.timeoutMs ?? 150_000,
    signal: opts.signal,
    onLog: opts.onLog,
  });
  return parseCtlJson<T>(check(res, what));
}

/** The CLI inside the running node container, against the daemon socket (named in ctl/config.toml). */
async function daemonExec(rt: NodeRuntime, args: string[], timeoutMs: number): Promise<ExecResult> {
  const layout = await cliLayoutOf(rt);
  return rt.exec([binariesFor(layout).ctl, ...baseArgs(), ...daemonCallArgs(args, layout)], timeoutMs);
}

export async function ctlDaemon<T>(rt: NodeRuntime, args: string[], what: string, timeoutMs = 60_000): Promise<T> {
  return parseCtlJson<T>(check(await daemonExec(rt, args, timeoutMs), what));
}

/**
 * dvpnctl cli config pointing at our RPC, signing with keys/owner.json.
 *
 * Works with both dvpnctl config layouts, because nodes deployed earlier keep their
 * older image:
 *   older: `key = 'owner'`, [daemon] socket, [tx] priority_fee / max_priority_fee /
 *          compute_unit_margin / loaded_data_limit; flag --daemon.socket
 *   newer (ddv18.32 / 8d5b93c): [key] name, [daemon] endpoint, [tx] *_lamports /
 *          *_percent / *_bytes; flag --daemon.endpoint
 * Both decode with viper, which ignores keys it does not know, so each field is
 * written under both names. The key name is left out: a string in one layout is a
 * table in the other, and both default to "owner". No daemon flag is passed, since
 * each version rejects the other's.
 */
export function ctlConfigToml(rpcUrl: string, daemonSocket: string = DAEMON_SOCKET): string {
  const ws = rpcUrl.replace(/^http/, 'ws');
  return [
    "output = 'json'",
    '',
    '[daemon]',
    `socket = '${daemonSocket}'`,
    `endpoint = '${daemonSocket}'`,
    '',
    '[log]',
    "format = 'console'",
    "level = 'warn'",
    '',
    '[rpc]',
    "commitment = 'confirmed'",
    'timeout = 30000000000',
    `url = '${rpcUrl}'`,
    `ws_url = '${ws}'`,
    '',
    '[tx]',
    "commitment = 'confirmed'",
    'compute_unit_margin = 20',
    'compute_unit_margin_percent = 20',
    'confirm_timeout = 90000000000',
    'loaded_data_limit = 8388608',
    'loaded_data_limit_bytes = 8388608',
    'max_priority_fee = 100000',
    'max_priority_fee_lamports = 100000',
    'priority_fee = 0',
    'priority_fee_lamports = 0',
    "priority_fee_mode = 'auto'",
    'retries = 5',
    'retry_delay = 3000000000',
    '',
  ].join('\n');
}

// ─── Typed views ───

export interface ProgramParams {
  mint: string;
  vault: string;
  treasury: string;
  feeBps: number;
  minNodeBond: number;
  unbondingSeconds: number;
  channelCloseGraceSeconds: number;
  nodeListingTtlSeconds: number;
  paused: number;
}

interface Wrapped<T> {
  address: string;
  slot: number;
  value: T;
}

/** Keys after camelKeys; id / country / uri are bytes (older) or text (newer). */
interface RawNode {
  nodeId: unknown;
  owner: string;
  status: number;
  listedAt: number;
  channelPricePerGb: number;
  channelPricePerHour: number;
  leasePricePerHour: number;
  protocols: number;
  country: unknown;
  uriLen?: number;
  uri: unknown;
  bond: number;
  revenue: number;
  feesAccrued: number;
  rentPayer: string;
  openedAt: number;
}

export interface ChainNode {
  address: string;
  nodeIdHex: string;
  owner: string;
  /** 1 = listed, 0 = delisted. */
  status: number;
  listedAt: number;
  prices: { perGb: number; perHour: number; leasePerHour: number };
  protocols: number;
  country: string;
  uri: string;
  bond: number;
  revenue: number;
  feesAccrued: number;
  rentPayer: string;
  openedAt: number;
}

/** Decode `node show` / `node search` rows from either layout (see ctl-json.ts). */
export function decodeNode(w: Wrapped<unknown>): ChainNode {
  const v = camelKeys(w.value) as RawNode;
  return {
    address: w.address,
    nodeIdHex: idHex(v.nodeId, 'node id'),
    owner: v.owner,
    status: v.status,
    listedAt: v.listedAt,
    prices: { perGb: v.channelPricePerGb, perHour: v.channelPricePerHour, leasePerHour: v.leasePricePerHour },
    protocols: v.protocols,
    country: fixedText(v.country, 'node country'),
    uri: fixedText(v.uri, 'node uri', v.uriLen),
    bond: v.bond,
    revenue: v.revenue,
    feesAccrued: v.feesAccrued,
    rentPayer: v.rentPayer,
    openedAt: v.openedAt,
  };
}

export interface ChainUnbonding {
  address: string;
  nodeIdHex: string;
  owner: string;
  amount: number;
  closedAt: number;
}

/** Keys after camelKeys; the amount is `amount` (older) or `bond` (newer). */
interface RawUnbonding {
  nodeId: unknown;
  owner: string;
  amount?: number;
  bond?: number;
  closedAt: number;
}

function decodeUnbonding(w: Wrapped<unknown>): ChainUnbonding {
  const v = camelKeys(w.value) as RawUnbonding;
  return {
    address: w.address,
    nodeIdHex: idHex(v.nodeId, 'unbonding node id'),
    owner: v.owner,
    amount: numberField(v as unknown as Record<string, unknown>, ['amount', 'bond'], 'unbonding amount'),
    closedAt: v.closedAt,
  };
}

// ─── PDAs ───

const PROGRAM = new PublicKey(PROGRAM_ID);

export function nodePda(owner: string, nodeIdHex: string): string {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('node'), new PublicKey(owner).toBuffer(), Buffer.from(nodeIdHex, 'hex')],
    PROGRAM,
  )[0].toBase58();
}

export function nodeUnbondingPda(owner: string, nodeIdHex: string): string {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('node_unbonding'), new PublicKey(owner).toBuffer(), Buffer.from(nodeIdHex, 'hex')],
    PROGRAM,
  )[0].toBase58();
}

// ─── Commands ───

export async function programParams(rt: NodeRuntime, opts?: CtlOptions): Promise<ProgramParams> {
  const raw = await ctl<Record<string, unknown>>(rt, ['program', 'params'], 'reading program params', opts);
  const p = programParamsFrom(raw);
  if (p.mint !== MINT) throw new Error(`program mint ${p.mint} does not match the app's ${MINT}`);
  return p;
}

/** Program params from either layout (the pause mask is `paused` or `pausedMask`). */
export function programParamsFrom(rawJson: Record<string, unknown>): ProgramParams {
  const raw = camelKeys(rawJson) as Record<string, unknown>;
  const n = (names: string[], what: string): number => numberField(raw, names, what);
  return {
    mint: String(raw.mint ?? ''),
    vault: String(raw.vault ?? ''),
    treasury: String(raw.treasury ?? ''),
    feeBps: n(['feeBps'], 'fee_bps'),
    minNodeBond: n(['minNodeBond'], 'min_node_bond'),
    unbondingSeconds: n(['unbondingSeconds'], 'unbonding_seconds'),
    channelCloseGraceSeconds: n(['channelCloseGraceSeconds'], 'channel_close_grace_seconds'),
    nodeListingTtlSeconds: n(['nodeListingTtlSeconds'], 'node_listing_ttl_seconds'),
    paused: n(['paused', 'pausedMask'], 'pause mask'),
  };
}

export interface TxResult {
  signature: string;
}

function sig(r: TxResult, what: string): string {
  if (!r?.signature) throw new Error(`${what}: dvpnctl returned no signature`);
  return r.signature;
}

export interface OpenNodeArgs {
  nodeIdHex: string;
  owner: string;
  ownerToken: string;
  vault: string;
  bondBase: number;
  country: string;
  protocols: number;
  uri: string;
  prices: { perGb: number; perHour: number; leasePerHour: number };
}

export async function openNode(rt: NodeRuntime, a: OpenNodeArgs, opts?: CtlOptions): Promise<string> {
  const r = await ctl<TxResult>(
    rt,
    [
      'node', 'open-node',
      '--node-id', a.nodeIdHex,
      '--bond', String(a.bondBase),
      '--country', a.country.toUpperCase(),
      '--protocols', String(a.protocols),
      '--uri', a.uri,
      '--prices.channel-price-per-gb', String(a.prices.perGb),
      '--prices.channel-price-per-hour', String(a.prices.perHour),
      '--prices.lease-price-per-hour', String(a.prices.leasePerHour),
      '--mint', MINT,
      '--vault', a.vault,
      '--owner-token', a.ownerToken,
      '--rent-payer', a.owner,
    ],
    'opening the node on chain',
    opts,
  );
  return sig(r, 'open_node');
}

export async function showNode(rt: NodeRuntime, address: string, opts?: CtlOptions): Promise<ChainNode | null> {
  try {
    return decodeNode(await ctl<Wrapped<RawNode>>(rt, ['node', 'show', address], 'reading the node account', opts));
  } catch (err) {
    if (isNotFound((err as Error).message)) return null;
    throw err;
  }
}

export async function listNode(rt: NodeRuntime, address: string, opts?: CtlOptions): Promise<string> {
  return sig(await ctl<TxResult>(rt, ['node', 'list-node', '--node', address], 'listing the node', opts), 'list_node');
}

export async function delistNode(rt: NodeRuntime, address: string, opts?: CtlOptions): Promise<string> {
  return sig(await ctl<TxResult>(rt, ['node', 'delist-node', '--node', address], 'delisting the node', opts), 'delist_node');
}

export async function closeNode(rt: NodeRuntime, address: string, owner: string, opts?: CtlOptions): Promise<string> {
  return sig(
    await ctl<TxResult>(rt, ['node', 'close-node', '--node', address, '--rent-payer', owner], 'closing the node (bond to unbonding)', opts),
    'close_node',
  );
}

export async function withdrawNodeRevenue(
  rt: NodeRuntime,
  a: { node: string; owner: string; ownerToken: string; vault: string; amountBase: number },
  opts?: CtlOptions,
): Promise<string> {
  return sig(
    await ctl<TxResult>(
      rt,
      [
        'node', 'withdraw-node-revenue',
        '--node', a.node,
        '--owner', a.owner,
        '--amount', String(a.amountBase),
        '--owner-token', a.ownerToken,
        '--mint', MINT,
        '--vault', a.vault,
      ],
      'withdrawing node revenue',
      opts,
    ),
    'withdraw_node_revenue',
  );
}

export async function withdrawNodeBond(
  rt: NodeRuntime,
  a: { unbonding: string; owner: string; ownerToken: string; vault: string },
  opts?: CtlOptions,
): Promise<string> {
  return sig(
    await ctl<TxResult>(
      rt,
      [
        'node', 'withdraw-node-bond',
        '--node-unbonding', a.unbonding,
        '--owner-token', a.ownerToken,
        '--mint', MINT,
        '--vault', a.vault,
        '--rent-payer', a.owner,
      ],
      'withdrawing the node bond',
      opts,
    ),
    'withdraw_node_bond',
  );
}

/** Matches every wording dvpnctl / Anchor use for "this account does not exist". */
export function isNotFound(msg: string): boolean {
  return /not ?found|does not exist|account .*empty|no data|AccountNotInitialized|\b3012\b|could not find account/i.test(msg);
}

/** The unbonding account by its derived address (authoritative, unlike a getProgramAccounts scan). */
export async function showUnbonding(rt: NodeRuntime, address: string, opts?: CtlOptions): Promise<ChainUnbonding | null> {
  try {
    const w = await ctl<Wrapped<RawUnbonding>>(rt, ['node', 'unbonding', 'show', address], 'reading the unbonding account', opts);
    return decodeUnbonding(w);
  } catch (err) {
    if (isNotFound((err as Error).message)) return null;
    throw err;
  }
}

export async function unbondings(rt: NodeRuntime, owner: string, opts?: CtlOptions): Promise<ChainUnbonding[]> {
  const rows = await ctl<Array<Wrapped<RawUnbonding>>>(rt, ['node', 'unbonding', 'search', '--owner', owner], 'reading unbondings', opts);
  return rows.map(decodeUnbonding);
}

// ─── Daemon (running node) ───

export interface DaemonSession {
  id?: string;
  [k: string]: unknown;
}

export async function daemonSessions(rt: NodeRuntime): Promise<DaemonSession[]> {
  const r = await ctlDaemon<DaemonSession[] | { sessions?: DaemonSession[] }>(rt, ['node', 'sessions'], 'listing sessions');
  return liveSessions(Array.isArray(r) ? r : (r.sessions ?? []));
}

/**
 * The daemon keeps ended sessions in its list with status "closed" (e.g. the paid self-test,
 * closed 7 s after it opened, NM-C9 T9 f). Only the others are live.
 */
export function liveSessions(all: DaemonSession[]): DaemonSession[] {
  return all.filter((s) => String(s.status ?? '').toLowerCase() !== 'closed');
}

export async function daemonRedeem(rt: NodeRuntime): Promise<unknown> {
  return ctlDaemon<unknown>(rt, ['node', 'redeem'], 'redeeming vouchers', 180_000);
}

/** Positions (channels/leases) the daemon is watching. */
export async function daemonPositions(rt: NodeRuntime): Promise<unknown[]> {
  const r = await ctlDaemon<unknown[] | { positions?: unknown[] }>(rt, ['node', 'positions'], 'listing positions');
  return Array.isArray(r) ? r : (r.positions ?? []);
}

/**
 * On-chain leases on a node (`lease search --node`). The lease account layout
 * is read tolerantly (camelCase as dvpnctl prints it, snake_case as a fallback)
 * because this app never re-implements the program layout.
 */
export interface ChainLease {
  address: string;
  provider?: string;
  escrow: number;
  ratePerHour?: number;
  openedAt?: number;
  status?: number | string;
}

export async function searchLeases(rt: NodeRuntime, node: string, opts?: CtlOptions): Promise<ChainLease[]> {
  const rows = await ctl<Array<{ address: string; value: Record<string, unknown> }>>(rt, ['lease', 'search', '--node', node], 'searching leases', opts);
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
  return rows.map((r) => {
    const v = r.value ?? {};
    return {
      address: r.address,
      provider: typeof v.provider === 'string' ? v.provider : undefined,
      escrow: num(v.escrow) ?? 0,
      ratePerHour: num(v.ratePerHour ?? v.rate_per_hour ?? v.pricePerHour ?? v.price_per_hour),
      openedAt: num(v.openedAt ?? v.opened_at),
      status: typeof v.status === 'number' || typeof v.status === 'string' ? v.status : undefined,
    };
  });
}

export function logCtlFailure(what: string, err: unknown): void {
  log.warn(`dvpnctl ${what} failed`, { err: (err as Error).message?.slice(0, 300) });
}

// ─── Read-only extras (coverage of the remaining node-role dvpnctl commands) ───

/** `program status` — the pause mask; a non-zero mask can block node instructions. */
export async function programStatus(rt: NodeRuntime, opts?: CtlOptions): Promise<Record<string, unknown>> {
  return ctl<Record<string, unknown>>(rt, ['program', 'status'], 'reading program status', opts);
}

/** `node inspect <node>` — verifies the node's signed metadata and its TLS pin over a pinned connection. */
export async function inspectNode(rt: NodeRuntime, address: string, opts?: CtlOptions): Promise<Record<string, unknown>> {
  return ctl<Record<string, unknown>>(rt, ['node', 'inspect', address], 'inspecting the node', { timeoutMs: 120_000, ...opts });
}

/** `version` — link-time identity of the image (network, program, mint, commit). */
export async function ctlVersion(rt: NodeRuntime, opts?: CtlOptions): Promise<Record<string, string>> {
  return ctl<Record<string, string>>(rt, ['version'], 'reading the image version', opts);
}

export async function daemonSession(rt: NodeRuntime, id: string): Promise<unknown> {
  return ctlDaemon<unknown>(rt, ['node', 'session', id], 'reading a session');
}

export async function daemonCloseSession(rt: NodeRuntime, id: string): Promise<unknown> {
  const res = await daemonExec(rt, ['node', 'close-session', id], 60_000);
  if (res.exitCode !== 0) throw new Error(`closing session ${id} failed: ${describeFailure(res.output)}`);
  return res.output.trim() ? parseCtlJsonOrText(res.output) : { closed: id };
}

export async function daemonRedemptions(rt: NodeRuntime): Promise<unknown> {
  return ctlDaemon<unknown>(rt, ['node', 'redemptions'], 'listing redemptions');
}

/** `daemon status` + `daemon version` over the node's control socket. */
export async function daemonInfo(rt: NodeRuntime): Promise<{ status: unknown; version: unknown }> {
  const status = await ctlDaemon<unknown>(rt, ['daemon', 'status'], 'reading daemon status');
  const version = await ctlDaemon<unknown>(rt, ['daemon', 'version'], 'reading daemon version');
  return { status, version };
}

function parseCtlJsonOrText(output: string): unknown {
  try {
    return parseCtlJson<unknown>(output);
  } catch (err) {
    log.debug('dvpnctl output is not JSON; returning text', { err: (err as Error).message });
    return { output: output.trim().slice(0, 500) };
  }
}
