import { log } from './logger';
import type { NodeRuntime } from './node-runtime';
import type { HnsSyncState } from '../../shared/types';

/**
 * Handshake (HNS) resolver on a node.
 *
 * The daemon starts `hnsd -r 127.0.0.1:5350` inside the node container when its
 * node config carries `[handshake_dns] enabled = true` (upstream runtime.go Serve),
 * and announces `handshake_dns` in its metadata. Both node images ship hnsd v2.0.0.
 * Turning it on or off is therefore: patch the node config, restart the daemon,
 * then check the hnsd process really came up (or really went away).
 */

// ─── Probe ───

/** True when an hnsd process runs in the node container. Alpine image: busybox pidof. */
export async function hnsdRunning(rt: NodeRuntime): Promise<boolean> {
  const r = await rt.exec(['sh', '-c', 'pidof hnsd >/dev/null'], 15_000);
  return r.exitCode === 0;
}

/**
 * Wait until hnsd is running (`want` true) or gone (`want` false). The daemon
 * starts hnsd only after its config loads, so a fresh restart needs a few seconds.
 */
export async function waitForHnsd(rt: NodeRuntime, want: boolean, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // A container mid-restart cannot answer yet: count that as "not there yet".
    const running = await hnsdRunning(rt).catch((err: unknown) => {
      log.debug('hnsd probe failed', { err: (err as Error).message });
      return !want;
    });
    if (running === want) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

/** Message for a resolver that was asked for but is not running. */
export function hnsdNotRunningMessage(logTail: string[]): string {
  const hint = logTail.filter((l) => /hnsd|handshake/i.test(l)).slice(-5).join('\n');
  return `The HNS resolver (hnsd) is enabled in the node config but is not running in the node container.${hint ? `\nNode logs:\n${hint}` : ''}`;
}

/**
 * hnsd and the users' DNS routing in one exec (H3, image 0.3.1+): the entrypoint wrapper runs
 * dnsmasq + unbound and adds the `inet nm_hns` redirect table when the resolver is on.
 */
export async function hnsProbe(rt: NodeRuntime): Promise<{ hnsd: boolean; routing: boolean; sync?: HnsSync }> {
  const r = await rt.exec(
    [
      'sh',
      '-c',
      'pidof hnsd >/dev/null && echo HNSD; pidof dnsmasq >/dev/null && pidof unbound >/dev/null && nft list table inet nm_hns >/dev/null 2>&1 && echo ROUTING; ' +
        'echo "HSTAT $(cat /run/nm-hnsd.status 2>/dev/null) NOW $(date +%s)"; true',
    ],
    15_000,
  );
  return { hnsd: /\bHNSD\b/.test(r.output), routing: /\bROUTING\b/.test(r.output), sync: parseHnsSync(r.output) };
}

// ─── HNS chain sync (image 0.3.5+) ───
// `pidof hnsd` also matches the supervisor (a script installed as hnsd), so "running" alone does not
// prove HNS names resolve: hnsd may be waiting to restart, unable to reach peers (outbound 12038
// blocked) or still syncing. The supervisor's log filter writes "<height> <unix time>" for the last
// header hnsd added; the app compares it with the container clock and the expected chain height.

export interface HnsSync {
  /** Last header height hnsd added; undefined before the first one (the supervisor writes 0). */
  height?: number;
  /** Seconds since hnsd last added a header (container clock). */
  ageSec?: number;
  /** Container clock, unix seconds. */
  nowSec: number;
}

export function parseHnsSync(output: string): HnsSync | undefined {
  const m = output.match(/HSTAT\s+(?:(\d+)\s+(\d+)\s+)?NOW\s+(\d+)/);
  if (!m) return undefined;
  if (!m[1]) return undefined; // no status file: an image before 0.3.5
  const nowSec = Number(m[3]);
  const height = Number(m[1]);
  return { height: height > 0 ? height : undefined, ageSec: Math.max(0, nowSec - Number(m[2])), nowSec };
}

/** Handshake mainnet genesis (2020-02-03) and target block time: ~expected height for a given time. */
const HNS_GENESIS_SEC = 1_580_745_078;
const HNS_BLOCK_SEC = 600;
/** No new header for this long = not syncing (blocks come every ~10 min). */
export const HNS_STALL_SEC = 45 * 60;
/**
 * Synced = within 0.5% of the expected height (~1,800 blocks, ~12 days). Measured 2026-11-12: the
 * real tip runs 0.21% behind the 10-minute target, so this lasts years; a restart from a checkpoint
 * (up to 2,000 blocks behind) shows "Syncing" for the seconds it takes to catch up. 97% (first cut)
 * called a node 4,000 blocks behind "synced" (P21).
 */
export const SYNCED_FRACTION = 0.995;

export function hnsSyncState(s: HnsSync | undefined): { state: HnsSyncState; percent?: number } {
  if (!s) return { state: 'unknown' }; // image before 0.3.5: no status file to read
  // No header since the supervisor started: fine for a few minutes, then hnsd can't reach peers.
  if (s.height === undefined) return { state: (s.ageSec ?? 0) > HNS_STALL_SEC ? 'stalled' : 'starting' };
  const expected = Math.max(1, Math.floor((s.nowSec - HNS_GENESIS_SEC) / HNS_BLOCK_SEC));
  const percent = Math.min(100, Math.floor((s.height / expected) * 100));
  if ((s.ageSec ?? 0) > HNS_STALL_SEC) return { state: 'stalled', percent };
  return s.height >= expected * SYNCED_FRACTION ? { state: 'synced', percent } : { state: 'syncing', percent };
}
