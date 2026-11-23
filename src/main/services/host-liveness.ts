// ─── Server liveness (Q0598) ───
// See node-manager.ts liveStatus: a server that did not answer over SSH is remembered for a
// minute, so status answers 'not live' at once and chain commands skip it. Its own module so it
// can be tested without node-manager's Electron/Docker imports.
import { log } from './logger';

export const HOST_DOWN_TTL_MS = 60_000;
/** Hard limit for the node probe on its server; a probe that never settles counts as down. */
export const HOST_PROBE_TIMEOUT_MS = 90_000;
const hostsDown = new Map<string, { at: number; message: string }>();

export function noteHostDown(host: string, message: string): void {
  if (!hostsDown.has(host)) log.info('server does not answer; its nodes are not live until it does', { host, err: message.slice(0, 200) });
  hostsDown.set(host, { at: Date.now(), message });
}

export function noteHostUp(host: string): void {
  if (hostsDown.delete(host)) log.info('server answers again', { host });
}

/** The recent "does not answer" for this server, or undefined once it is older than HOST_DOWN_TTL_MS. */
export function hostDownNow(host: string | undefined): { at: number; message: string } | undefined {
  if (!host) return undefined;
  const h = hostsDown.get(host);
  if (!h) return undefined;
  if (Date.now() - h.at > HOST_DOWN_TTL_MS) return undefined; // stale: probe again (kept until noteHostUp)
  return h;
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} does not answer over SSH (no reply in ${Math.round(ms / 1000)} s)`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Whether one status answer proves a node is not live (Q0598/Q0602). Only a real answer counts:
 * its server did not answer (serverDown), or the chain was read and the node is delisted, expired
 * or gone (chainStatus set, reachable false). A chain read that failed (an RPC 429 at app start, a
 * node with no SSH session) is unknown: the node keeps its state. rc12 marked three healthy nodes
 * not live on one 429.
 */
export function provesNotLive(status: { reachable: boolean; serverDown?: boolean; chainStatus?: string }): boolean {
  if (status.reachable) return false;
  if (status.serverDown) return true;
  return status.chainStatus !== undefined;
}
