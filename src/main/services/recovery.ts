import { createHash } from 'node:crypto';
import { PublicKey, type ConfirmedSignatureInfo, type ParsedTransactionWithMeta } from '@solana/web3.js';
import { MEMO_PROGRAM, PROGRAM_ID } from './chain';
import { log } from './logger';
import { connection, isTransientRpcError, withRetry, withRpcTimeout, RPC_QUERY_TIMEOUT_MS } from './solana-client';
import { readStore, writeStore, type DiscoveredNode } from './store';

/**
 * NM032 "Find my nodes": rebuild the list of nodes this wallet funded, from the chain alone.
 *
 * Every deploy since 0.2 funds the node's own key with one transaction from the app wallet that
 * carries the memo `fund node <moniker>` (deploy.ts). That transaction is public, so the wallet's
 * history names every node it ever paid for, with its moniker and its key (the transfer's
 * recipient = the node's on-chain owner). No Docker, no SSH and no store.json are needed, which is
 * exactly the situation of a user whose list was wiped and whose Docker Desktop is often off.
 *
 * A key that was funded but never opened a node (a deploy cancelled after funding) has no
 * transaction with the dvpn program; those are marked `noNodeOnChain` and never shown as nodes.
 */

export const FUND_MEMO_PREFIX = 'fund node ';
const PAGE = 1000;
/** Pause between RPC calls: the reporter's log shows devnet 429s at normal app load. */
const THROTTLE_MS = 250;
/**
 * Extra rounds for the node-account lookup when the RPC keeps rate-limiting after withRetry's own
 * attempts (Q0594). Exported so tests can set them to 0.
 */
export const LIVE_LOOKUP_BACKOFF_MS = [5_000, 10_000, 20_000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Highest transaction version to ask the RPC for. Node keys sign with the node image's CLI, which
 * sends version-1 transactions; asking for 0 made the RPC refuse every one of them (Q0584).
 */
const MAX_TX_VERSION = 1;

/** One parsed transaction, or null when the RPC cannot return it (never aborts the whole scan). */
async function parsedTx(signature: string, what: string): Promise<ParsedTransactionWithMeta | null> {
  try {
    return await withRetry(
      async () => withRpcTimeout(async () => (await connection()).getParsedTransaction(signature, { maxSupportedTransactionVersion: MAX_TX_VERSION }), RPC_QUERY_TIMEOUT_MS, what),
      what,
    );
  } catch (err) {
    log.warn('find my nodes: transaction unreadable, skipped', { what, sig: signature, err: (err as Error).message });
    return null;
  }
}

/**
 * Verdict of the program check over a node key's transactions: a node when any readable one called
 * the dvpn program; a cancelled deploy only when every transaction was readable and none did;
 * unknown otherwise (shown as a node: hiding a real node is worse than listing a cancelled one).
 */
export function programCheckVerdict(results: Array<'program' | 'other' | 'unreadable'>): 'node' | 'no-node' | 'unknown' {
  if (results.includes('program')) return 'node';
  if (results.includes('unreadable')) return 'unknown';
  return 'no-node';
}

/**
 * The memo field of getSignaturesForAddress reads `[<len>] <text>` (one entry per memo, joined by
 * "; "). Returns the moniker when this transaction is a node funding, else null.
 */
export function monikerFromSignatureMemo(memo: string | null | undefined): string | null {
  if (!memo) return null;
  for (const part of memo.split('; ')) {
    const text = part.replace(/^\[\d+\]\s*/, '');
    if (text.startsWith(FUND_MEMO_PREFIX)) {
      const moniker = text.slice(FUND_MEMO_PREFIX.length).trim();
      if (moniker) return moniker;
    }
  }
  return null;
}

/**
 * From a parsed funding transaction: the key that received SOL from `wallet` in a transaction
 * whose memo is `fund node <moniker>`. Null when the shape does not match (never guesses).
 */
export function fundingFromParsedTx(tx: ParsedTransactionWithMeta, wallet: string): { operator: string; moniker: string } | null {
  if (tx.meta?.err) return null;
  let moniker: string | null = null;
  let operator: string | null = null;
  for (const ix of tx.transaction.message.instructions) {
    const pid = ix.programId.toBase58();
    if (pid === MEMO_PROGRAM && 'parsed' in ix && typeof ix.parsed === 'string' && ix.parsed.startsWith(FUND_MEMO_PREFIX)) {
      moniker = ix.parsed.slice(FUND_MEMO_PREFIX.length).trim() || null;
    }
    if ('parsed' in ix && ix.program === 'system' && ix.parsed?.type === 'transfer') {
      const info = ix.parsed.info as { source?: string; destination?: string };
      if (info.source === wallet && info.destination && info.destination !== wallet) operator = info.destination;
    }
  }
  return moniker && operator ? { operator, moniker } : null;
}

/** Every signature of `address`, newest first, paged. Throttled; retried on transient RPC errors. */
async function allSignatures(address: string, max = 20_000): Promise<ConfirmedSignatureInfo[]> {
  const conn = await connection();
  const key = new PublicKey(address);
  const out: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  while (out.length < max) {
    const page = await withRetry(
      () => withRpcTimeout(() => conn.getSignaturesForAddress(key, { before, limit: PAGE }), RPC_QUERY_TIMEOUT_MS, 'wallet history'),
      'wallet history',
    );
    out.push(...page);
    if (page.length < PAGE) break;
    before = page[page.length - 1].signature;
    await sleep(THROTTLE_MS);
  }
  return out;
}

// ─── Live node account by owner (no Docker) ───

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(bytes: Uint8Array): string {
  let n = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'));
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

/** Anchor account tag of the dvpn program's Node account: sha256("account:Node")[0..8]. */
export const NODE_ACCOUNT_TAG = createHash('sha256').update('account:Node').digest().subarray(0, 8);
/**
 * Byte offset of the owner key in a Node account: tag (8) + node id (32). Measured on the deployed
 * devnet program (Q0586): all six NM032 nodes match at 40, a removed node and a cancelled deploy match none.
 */
export const NODE_OWNER_OFFSET = 40;

/**
 * Host a node advertises, found by pattern in its account bytes (the uri is stored as text). Display
 * only, so it does not depend on the account layout: null when no uri-shaped text is there.
 */
export function hostFromAccountData(data: Uint8Array): string | null {
  const m = Buffer.from(data).toString('latin1').match(/[a-z][a-z0-9+.-]*:\/\/[!-~]+/i);
  if (!m) return null;
  try {
    return new URL(m[0]).hostname || null;
  } catch (err) {
    log.debug('find my nodes: uri-shaped text is not a URL', { text: m[0].slice(0, 80), err: (err as Error).message });
    return null;
  }
}

/**
 * The node account this key owns right now (address + advertised host); null when there is none
 * (removed, or never opened); 'busy' when the RPC kept rate-limiting through every retry round
 * (Q0594: that is not an answer, and must not fall back to the history check, which cannot tell a
 * removed node from a live one); undefined when the RPC refuses the query (some refuse
 * getProgramAccounts), the only case for the history check.
 */
async function liveNodeAccount(operator: string): Promise<{ pda: string; host: string | null } | null | 'busy' | undefined> {
  for (let round = 0; ; round++) {
    try {
      return await nodeAccountOnce(operator);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (!isTransientRpcError(msg)) {
        log.warn('find my nodes: node account lookup refused by the RPC; using the history check', { operator, err: msg.slice(0, 200) });
        return undefined;
      }
      if (round >= LIVE_LOOKUP_BACKOFF_MS.length) {
        log.warn('find my nodes: RPC still busy after every retry; listing this key as unverified', { operator, err: msg.slice(0, 200) });
        return 'busy';
      }
      log.info('find my nodes: RPC busy on the node account lookup; waiting', { operator, waitMs: LIVE_LOOKUP_BACKOFF_MS[round] });
      await sleep(LIVE_LOOKUP_BACKOFF_MS[round]);
    }
  }
}

async function nodeAccountOnce(operator: string): Promise<{ pda: string; host: string | null } | null> {
  const conn = await connection();
  const rows = await withRetry(
    () =>
      withRpcTimeout(
        () =>
          conn.getProgramAccounts(new PublicKey(PROGRAM_ID), {
            filters: [{ memcmp: { offset: 0, bytes: base58(NODE_ACCOUNT_TAG) } }, { memcmp: { offset: NODE_OWNER_OFFSET, bytes: operator } }],
          }),
        RPC_QUERY_TIMEOUT_MS,
        'node account by owner',
      ),
    'node account by owner',
  );
  const row = rows[0];
  return row ? { pda: row.pubkey.toBase58(), host: hostFromAccountData(row.account.data) } : null;
}

/** Whether this key ever sent a transaction to the dvpn program (open_node etc.). */
async function touchedProgram(operator: string): Promise<'node' | 'no-node' | 'unknown'> {
  const conn = await connection();
  let sigs: ConfirmedSignatureInfo[];
  try {
    sigs = await withRetry(
      () => withRpcTimeout(() => conn.getSignaturesForAddress(new PublicKey(operator), { limit: 25 }), RPC_QUERY_TIMEOUT_MS, 'node key history'),
      'node key history',
    );
  } catch (err) {
    log.warn('find my nodes: node key history unreadable', { operator, err: (err as Error).message });
    return 'unknown';
  }
  const results: Array<'program' | 'other' | 'unreadable'> = [];
  for (const s of sigs) {
    if (s.err) continue;
    await sleep(THROTTLE_MS);
    const tx = await parsedTx(s.signature, 'node key tx');
    if (!tx) {
      results.push('unreadable');
      continue;
    }
    const hit = tx.transaction.message.instructions.some((ix) => ix.programId.toBase58() === PROGRAM_ID);
    results.push(hit ? 'program' : 'other');
    if (hit) break;
  }
  return programCheckVerdict(results);
}

export interface DiscoverResult {
  /** Nodes found that the list does not hold (view only until their server is reconnected). */
  found: DiscoveredNode[];
  /** Funded keys with no node account now (cancelled deploys, removed nodes); never shown as nodes. */
  fundedOnly: number;
  /** Funded keys already in the node list. */
  alreadyManaged: number;
  scannedTxs: number;
}

/** Optional chain detail (PDA, status, host) when a chain reader is available; see node-manager. */
export type ChainLookup = (operator: string) => Promise<{ nodePda: string; nodeIdHex: string; status: number; host?: string } | null>;

/**
 * Scan the app wallet's history and store what it finds in `store.discoveredNodes`.
 * `lookup` (node search --owner) is used when given and working; without it the program check
 * above still separates real nodes from cancelled deploys.
 */
export async function discoverFromWallet(lookup?: ChainLookup, opts: { wallet?: string } = {}): Promise<DiscoverResult> {
  const store = await readStore();
  // A given address is a read-only scan (support, long-history tests): it needs no key and saves nothing.
  const readOnly = opts.wallet !== undefined;
  if (readOnly) new PublicKey(opts.wallet as string); // throws on a malformed address
  const wallet = readOnly ? (opts.wallet as string) : store.wallet?.address;
  if (!wallet) throw new Error('Set up or import the app wallet first: nodes are found from the wallet that funded them.');

  const sigs = await allSignatures(wallet);
  const funding = sigs.filter((s) => !s.err && monikerFromSignatureMemo(s.memo));
  log.info('find my nodes: wallet history scanned', { txs: sigs.length, fundings: funding.length });

  const managed = new Set(readOnly ? [] : store.nodes.map((n) => n.operatorAddress));
  const previous = new Map((store.discoveredNodes ?? []).map((d) => [d.operatorAddress, d]));
  const byOperator = new Map<string, DiscoveredNode>();
  let alreadyManaged = 0;

  for (const s of funding) {
    await sleep(THROTTLE_MS);
    const tx = await parsedTx(s.signature, 'funding tx');
    const f = tx ? fundingFromParsedTx(tx, wallet) : null;
    if (!f) {
      log.debug('find my nodes: funding memo without a matching transfer', { sig: s.signature });
      continue;
    }
    if (managed.has(f.operator)) {
      alreadyManaged += 1;
      continue;
    }
    if (byOperator.has(f.operator)) continue; // newest funding wins (signatures are newest first)
    byOperator.set(f.operator, {
      ...previous.get(f.operator),
      operatorAddress: f.operator,
      moniker: f.moniker,
      fundTx: s.signature,
      fundedAt: new Date((s.blockTime ?? 0) * 1000).toISOString(),
    });
  }

  let fundedOnly = 0;
  for (const d of byOperator.values()) {
    let detail: Awaited<ReturnType<ChainLookup>> | undefined;
    if (lookup) {
      try {
        detail = await lookup(d.operatorAddress);
      } catch (err) {
        log.debug('find my nodes: chain lookup unavailable, using the program check', { err: (err as Error).message });
        lookup = undefined; // one failure means no reader (Docker off); stop trying per node
      }
    }
    if (detail) {
      Object.assign(d, { nodePda: detail.nodePda, chainNodeIdHex: detail.nodeIdHex, chainStatus: detail.status, host: detail.host ?? d.host, noNodeOnChain: false, unverified: false });
    } else if (detail === null) {
      d.noNodeOnChain = true; // the reader answered: no node account for this key
    } else {
      await sleep(THROTTLE_MS);
      // A node exists while its account does (Q0586): a removed node's key has the most program calls of all.
      const live = await liveNodeAccount(d.operatorAddress);
      if (live === 'busy') {
        // Listed (a real node must never vanish because devnet was busy), but never shown as confirmed.
        d.noNodeOnChain = false;
        d.unverified = true;
        d.checkedAt = new Date().toISOString();
        continue;
      }
      if (live !== undefined) {
        d.noNodeOnChain = live === null;
        d.unverified = false;
        if (live) {
          d.nodePda = live.pda;
          if (live.host) d.host = live.host;
        }
        d.checkedAt = new Date().toISOString();
        if (d.noNodeOnChain) fundedOnly += 1;
        continue;
      }
      const verdict = await touchedProgram(d.operatorAddress);
      d.noNodeOnChain = verdict === 'no-node';
      // The history check cannot tell a removed node from a live one: what it lists is unverified.
      d.unverified = !d.noNodeOnChain;
      if (verdict === 'unknown') log.warn('find my nodes: could not verify this key on chain; listing it', { operator: d.operatorAddress });
    }
    d.checkedAt = new Date().toISOString();
    if (d.noNodeOnChain) fundedOnly += 1;
  }

  const found = [...byOperator.values()].filter((d) => !d.noNodeOnChain);
  if (readOnly) {
    log.info('find my nodes: read-only scan done (not saved)', { wallet, found: found.length, fundedOnly, scannedTxs: sigs.length });
    return { found, fundedOnly, alreadyManaged, scannedTxs: sigs.length };
  }
  const fresh = await readStore();
  fresh.discoveredNodes = [...byOperator.values()];
  await writeStore(fresh);
  log.info('find my nodes: done', { found: found.length, fundedOnly, alreadyManaged });
  return { found, fundedOnly, alreadyManaged, scannedTxs: sigs.length };
}

/** View-only rows for the Nodes page: found, not managed, not a cancelled deploy. */
export async function discoveredNodes(): Promise<DiscoveredNode[]> {
  const store = await readStore();
  const managed = new Set(store.nodes.map((n) => n.operatorAddress));
  return (store.discoveredNodes ?? []).filter((d) => !d.noNodeOnChain && !managed.has(d.operatorAddress));
}

/** Drop discovered entries once their node is in the list (after adopting it from its server). */
export async function forgetDiscovered(operators: string[]): Promise<void> {
  if (!operators.length) return;
  const store = await readStore();
  const drop = new Set(operators);
  const next = (store.discoveredNodes ?? []).filter((d) => !drop.has(d.operatorAddress));
  if (next.length === (store.discoveredNodes ?? []).length) return;
  store.discoveredNodes = next;
  await writeStore(store);
}
