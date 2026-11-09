import { PublicKey } from '@solana/web3.js';
import { MINT, PROGRAM_ID } from './chain';
import { ctl, ctlConfigToml, programParams, type TxResult } from './dvpnctl';
import { camelKeys } from './ctl-json';
import { openRuntime, type NodeRuntime } from './node-runtime';
import { chainCtlImageTag, localCtlImageTag } from './docker';
import { appKeypair, tokenAccount } from './wallet';
import { keypairToJson } from './keys';
import { pickRPC } from './solana-client';
import { readStore, writeStore } from './store';
import { RESERVED_RUNTIME_HOME_IDS } from './validate';
import { addEvent } from './events';
import { log } from './logger';

/**
 * Close the voucher channels that "Test node" opened and return their
 * unspent escrow to the app wallet.
 *
 *   open (0)     → start_close_channel (starts the 7200 s grace that lets the
 *                  node redeem outstanding vouchers)
 *   closing (1)  → once closeStartedAt + grace has passed: close_channel, which
 *                  credits escrow − redeemed to the wallet's User balance
 *   finally      → withdraw_user_balance to the wallet's token account
 *
 * Only channels recorded in store.testChannels are touched — never anything
 * else the same wallet may own. The User balance is withdrawn only when this
 * sweep closed a channel (or a previous sweep closed one and its withdraw
 * failed — `testChannelRefundPending`), so a wallet shared with other tools
 * never has its balance moved underneath them.
 */

// A dedicated scratch id (UUID shape is required by the runtime). Taken from the shared
// reserved list so host-leftover cleanup passes over it.
const WALLET_CTL_ID = RESERVED_RUNTIME_HOME_IDS[1];
// Key-less home for read-only channel listings, apart from the sweep's signing home.
const CHANNEL_LIST_ID = RESERVED_RUNTIME_HOME_IDS[2];

interface RawChannel {
  owner: string;
  node: string;
  status: number;
  mode: number;
  escrow: number;
  redeemed: number;
  closeStartedAt: number;
  rentPayer?: string;
}

export interface SweepResult {
  /** True when nothing was sent: `startedClose` / `closed` list what WOULD be sent. */
  dryRun: boolean;
  startedClose: string[];
  closed: string[];
  pending: Array<{ channel: string; maturesAt: string }>;
  withdrawnBase: number;
  /** Base units sitting in the wallet's User balance after this sweep (0 when withdrawn). */
  userBalanceBase: number;
  errors: string[];
}

export async function recordTestChannel(channel: string, node: string): Promise<void> {
  const s = await readStore();
  s.testChannels = s.testChannels ?? [];
  if (!s.testChannels.some((c) => c.channel === channel)) s.testChannels.push({ channel, node, openedAt: new Date().toISOString() });
  await writeStore(s);
}

/**
 * The app wallet's channels to `node` that exist on chain now (read-only, no key).
 * The self-test lists them before and after its run, so a channel whose open landed
 * while `session start` still failed (RPC 429, daemon error) is recorded too; its
 * escrow would otherwise never come back.
 */
export async function walletChannelsTo(node: string, imageTag?: string): Promise<Set<string>> {
  const owner = (await appKeypair()).publicKey.toBase58();
  const rt = await openRuntime({ id: CHANNEL_LIST_ID, target: 'local', runtimeId: undefined, host: undefined, imageTag: await localCtlImageTag(imageTag) });
  try {
    await rt.prepare();
    await rt.writeFile('ctl/config.toml', ctlConfigToml(await pickRPC()), 0o600);
    const rows = await ctl<Array<{ address: string; value: unknown }>>(rt, ['channel', 'search', '--owner', owner], 'listing the wallet channels');
    return new Set(rows.filter((r) => (camelKeys(r.value) as RawChannel).node === node).map((r) => r.address));
  } finally {
    await rt.removeHome().catch((err: unknown) => log.debug('channel list home cleanup failed', { err: (err as Error).message }));
    await rt.close();
  }
}

export function userPda(owner: string): string {
  return PublicKey.findProgramAddressSync([Buffer.from('user'), new PublicKey(owner).toBuffer()], new PublicKey(PROGRAM_ID))[0].toBase58();
}

const gap = () => new Promise((r) => setTimeout(r, 7_000));

async function userBalance(rt: NodeRuntime, owner: string): Promise<number> {
  try {
    const user = await ctl<{ value: { balance: number } }>(rt, ['user', 'show', userPda(owner)], 'reading the wallet user balance');
    return user.value.balance;
  } catch (err) {
    // No User account yet means nothing was ever credited: balance 0.
    if (/not found|does not exist|account .*empty|no data/i.test((err as Error).message)) return 0;
    throw err;
  }
}

export async function sweepTestChannels(opts: { dryRun?: boolean } = {}): Promise<SweepResult> {
  const dryRun = !!opts.dryRun;
  const out: SweepResult = { dryRun, startedClose: [], closed: [], pending: [], withdrawnBase: 0, userBalanceBase: 0, errors: [] };
  const store = await readStore();
  const tracked = store.testChannels ?? [];
  const refundPendingBefore = !!store.testChannelRefundPending;
  const wallet = await appKeypair();
  const owner = wallet.publicKey.toBase58();
  const rt = await openRuntime({ id: WALLET_CTL_ID, target: 'local', runtimeId: undefined, host: undefined, imageTag: await chainCtlImageTag() });
  try {
    await rt.prepare();
    await rt.writeFile('ctl/keys/owner.json', keypairToJson(wallet), 0o600);
    await rt.writeFile('ctl/config.toml', ctlConfigToml(await pickRPC()), 0o600);
    const params = await programParams(rt);
    // camelKeys: newer dvpnctl prints snake_case keys (see ctl-json.ts).
    const live = (await ctl<Array<{ address: string; value: unknown }>>(rt, ['channel', 'search', '--owner', owner], 'listing channels')).map(
      (r) => ({ address: r.address, value: camelKeys(r.value) as RawChannel }),
    );
    const byAddr = new Map(live.map((c) => [c.address, c.value]));
    const now = Math.floor(Date.now() / 1000);
    const keep: typeof tracked = [];
    let closeMayHaveLanded = false;

    for (const t of tracked) {
      const v = byAddr.get(t.channel);
      if (!v) {
        // Account gone: already closed by an earlier sweep.
        if (dryRun) keep.push(t);
        continue;
      }
      try {
        if (v.status === 0 && v.mode === 0) {
          if (!dryRun) await ctl<TxResult>(rt, ['channel', 'start-close-channel', '--channel', t.channel], 'start-closing a test channel');
          out.startedClose.push(t.channel);
          out.pending.push({ channel: t.channel, maturesAt: new Date((now + params.channelCloseGraceSeconds) * 1000).toISOString() });
          keep.push(t);
          if (!dryRun) await gap();
        } else if (v.status === 1) {
          const ready = v.closeStartedAt + params.channelCloseGraceSeconds;
          if (now < ready) {
            out.pending.push({ channel: t.channel, maturesAt: new Date(ready * 1000).toISOString() });
            keep.push(t);
            continue;
          }
          if (!dryRun) {
            await ctl<TxResult>(
              rt,
              ['channel', 'close-channel', '--channel', t.channel, '--node', v.node, '--user', userPda(owner), '--rent-payer', v.rentPayer ?? owner],
              'closing a test channel',
            );
            await gap();
          } else {
            keep.push(t);
          }
          out.closed.push(t.channel);
        } else {
          keep.push(t);
        }
      } catch (err) {
        out.errors.push(`${t.channel}: ${(err as Error).message}`);
        keep.push(t);
        // A close that timed out may still have landed and credited the User
        // balance: make sure the next sweep withdraws whatever is there.
        if (v.status === 1 && !dryRun) closeMayHaveLanded = true;
      }
    }

    // Refund: only what our own closes credited (this run, or a previous run
    // whose withdraw failed). Never touch a balance we did not create.
    let refundPending = refundPendingBefore;
    if (out.closed.length || refundPendingBefore) {
      try {
        const bal = await userBalance(rt, owner);
        out.userBalanceBase = bal;
        if (bal > 0) {
          if (!dryRun) {
            await ctl<TxResult>(
              rt,
              ['user', 'withdraw-user-balance', '--owner-token', tokenAccount(owner).toBase58(), '--mint', MINT, '--vault', params.vault, '--rent-payer', owner],
              'withdrawing the user balance',
            );
            out.withdrawnBase = bal;
            out.userBalanceBase = 0;
            refundPending = false;
          }
        } else {
          refundPending = false;
        }
      } catch (err) {
        out.errors.push(`withdraw-user-balance: ${(err as Error).message}`);
        if (!dryRun) refundPending = true;
      }
    }
    if (closeMayHaveLanded) refundPending = true;

    if (!dryRun) {
      const s = await readStore();
      // Merge: a test session that finished while this sweep ran may have
      // recorded a new channel; it must not be dropped.
      const seen = new Set(tracked.map((t) => t.channel));
      s.testChannels = [...keep, ...(s.testChannels ?? []).filter((c) => !seen.has(c.channel))];
      s.testChannelRefundPending = refundPending;
      await writeStore(s);
      if (out.closed.length || out.startedClose.length) {
        await addEvent({
          kind: 'withdraw-sent',
          title: 'Test channels swept',
          subtitle: `${out.startedClose.length} closing · ${out.closed.length} closed · ${out.withdrawnBase} base units back · ${out.pending.length} waiting`,
        });
      }
    }
  } finally {
    await rt.removeFile('ctl/keys/owner.json').catch((err: unknown) => log.warn('wallet ctl key cleanup failed', { err: String(err) }));
    await rt.close();
  }
  return out;
}
