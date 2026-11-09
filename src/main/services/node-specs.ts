import { PublicKey } from '@solana/web3.js';
import type { Client } from 'ssh2';
import { addEvent } from './events';
import { dockerOverview } from './docker';
import { log } from './logger';
import { connection, sendTx, withRetry } from './solana-client';
import { buildLocalSystemReport } from './system-report';
import { readStore } from './store';
import { memoInstruction } from './wallet';
import { withSSH, runRemote } from './ssh';
import type { DeployedNode, NodeSpecsSnapshot, SSHCredentials } from '../../shared/types';
import { getNode, getSSH, nodeKeypair, updateNode } from './node-manager';

/**
 * On-chain hardware specs reporting (specs:v1).
 *
 * After a node is listed, the manager sends an SPL Memo transaction signed
 * by the node key carrying the node's hardware snapshot:
 *
 *   signer == node owner
 *   memo.startsWith('specs:v1:')
 *
 * This is operator-reported, NOT consensus-validated — CQAP attestation
 * supersedes it once that lands.
 *
 * Memo schema v1 (compact JSON, ≤ 240 bytes after `specs:v1:`):
 *   { cpu, c, cr, r, rr }
 *     cpu  – CPU model string, truncated to 64 chars
 *     c    – total logical cores on the host
 *     cr   – cores AVAILABLE to the dvpn-node container (Docker/WSL2 VM)
 *     r    – total host RAM (MiB)
 *     rr   – RAM AVAILABLE to the dvpn-node container (Docker/WSL2 VM, MiB)
 *
 * NOTE on `cr`/`rr` semantics: the node container is launched with no CPU or
 * memory cap (see docker.ts HostConfig — no Memory/NanoCpus), so nothing is
 * "reserved". On Windows the container runs inside the WSL2 VM, which the
 * Docker engine sizes BELOW the host (default RAM = min(50% host, 8 GB)).
 * `docker info` NCPU/MemTotal report that VM allocation — the real ceiling a
 * container can draw from — which is why `cr`/`rr` mean "available to the
 * container", not "reserved for it". On a single-purpose Linux VPS the VM ==
 * host, so cr==c and rr==r there. If we ever set real HostConfig limits, these
 * become true reservations and the schema should bump to v2.
 */

const MEMO_PREFIX = 'specs:v1:';
const MEMO_MAX_BYTES = 500;
const CPU_MAX_CHARS = 64;

/** Capture the host's hardware snapshot. Used for `target: 'local'` deploys. */
export async function captureLocalSpecs(): Promise<NodeSpecsSnapshot> {
  const report = await buildLocalSystemReport();
  let dockerNcpu: number | undefined;
  let dockerMemMb: number | undefined;
  try {
    const overview = await dockerOverview();
    dockerNcpu = overview.ncpu;
    dockerMemMb = overview.totalMemoryMb;
  } catch (err) {
    log.debug('dockerOverview failed during specs capture', { err: String(err) });
  }
  return {
    cpu: truncateCpu(report.cpuModel),
    c: report.cpuCores,
    // `cr`/`rr` = resources AVAILABLE to the container, not reserved for it.
    // The node container runs with no CPU/memory cap, so its real ceiling is
    // whatever the Docker engine exposes. On Windows that's the WSL2 VM
    // allocation (docker info NCPU/MemTotal), which sits below the host total
    // (default RAM = min(50% host, 8 GB)) — so `rr` < `r` there and the two
    // fields carry distinct, meaningful info. Fall back to host totals only if
    // the docker info probe failed (engine down), since on a single-purpose
    // box the VM == host anyway.
    cr: dockerNcpu ?? report.cpuCores,
    r: report.memoryMb,
    rr: dockerMemMb ?? report.memoryMb,
  };
}

/**
 * Probe a remote host for hardware specs over an existing SSH session
 * (`ssh2.Client`). All commands are read-only and bail-safe — if any
 * single probe fails we still return what we managed to capture.
 *
 * Throws only if every probe fails, in which case the caller should log
 * a warning and skip publishing for this node. Deploy itself does not
 * fail just because the spec probe couldn't run.
 */
export async function captureRemoteSpecs(creds: SSHCredentials): Promise<NodeSpecsSnapshot> {
  return withSSH(creds, async (client: Client) => {
    const cores = await sshOne(client, 'nproc');
    const memInfo = await sshOne(client, 'cat /proc/meminfo');
    const cpuInfo = await sshOne(client, 'cat /proc/cpuinfo');

    const c = parseInt(cores.trim(), 10);
    const memTotalKb = matchKv(memInfo, /^MemTotal:\s+(\d+)\s*kB/m);
    const cpuModel = matchKv(cpuInfo, /^model name\s*:\s*(.+)$/m) ?? 'Unknown CPU';

    if (!Number.isFinite(c) || c <= 0) {
      throw new Error('remote nproc returned no cores');
    }
    if (!memTotalKb) {
      throw new Error('remote /proc/meminfo missing MemTotal');
    }
    const r = Math.round(parseInt(memTotalKb, 10) / 1024);

    // Probe the remote Docker engine for what it actually exposes to
    // containers (NCPU / MemTotal), mirroring what local does via
    // dockerOverview(). `docker info` emits stable Go-template keys, so we
    // ask for exactly the two values and parse them line-by-line. This is
    // bail-safe: if Docker isn't reachable over SSH (not installed, perms,
    // daemon down) we fall back to host totals — on a single-purpose VPS the
    // engine == host, so cr==c / rr==r is the right default there anyway.
    let dockerNcpu: number | undefined;
    let dockerMemMb: number | undefined;
    try {
      // {{.NCPU}} = logical CPUs the engine sees; {{.MemTotal}} = bytes.
      const info = await sshOne(
        client,
        'docker info --format "{{.NCPU}}|{{.MemTotal}}"',
      );
      const [ncpuStr, memBytesStr] = info.trim().split('|');
      const ncpu = parseInt(ncpuStr, 10);
      const memBytes = parseInt(memBytesStr, 10);
      if (Number.isFinite(ncpu) && ncpu > 0) dockerNcpu = ncpu;
      if (Number.isFinite(memBytes) && memBytes > 0) {
        dockerMemMb = Math.round(memBytes / (1024 * 1024));
      }
    } catch (err) {
      log.debug('remote docker info probe failed during specs capture', {
        err: String(err),
      });
    }

    return {
      cpu: truncateCpu(cpuModel),
      c,
      // `cr`/`rr` = resources AVAILABLE to the container (Docker engine view),
      // not reserved. Falls back to host totals when the engine probe fails.
      cr: dockerNcpu ?? c,
      r,
      rr: dockerMemMb ?? r,
    };
  });
}

async function sshOne(client: Client, cmd: string): Promise<string> {
  const res = await runRemote(client, cmd, undefined, { timeoutMs: 15_000 });
  if (res.code !== 0) {
    throw new Error(`'${cmd}' exited ${res.code}: ${(res.stderr || res.stdout).slice(-200)}`);
  }
  return res.stdout;
}

function matchKv(haystack: string, re: RegExp): string | undefined {
  const m = haystack.match(re);
  return m ? m[1].trim() : undefined;
}

function truncateCpu(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, CPU_MAX_CHARS);
}

/**
 * Build the memo string, kept well inside one transaction (SPL Memo has no
 * separate cap; the 1232-byte packet limit is the real ceiling).
 */
export function buildSpecsMemo(snapshot: NodeSpecsSnapshot): string {
  const compact = {
    cpu: snapshot.cpu.slice(0, CPU_MAX_CHARS),
    c: snapshot.c,
    cr: snapshot.cr,
    r: snapshot.r,
    rr: snapshot.rr,
  };
  const memo = `${MEMO_PREFIX}${JSON.stringify(compact)}`;
  const bytes = Buffer.byteLength(memo, 'utf8');
  if (bytes > MEMO_MAX_BYTES) {
    // Defensive truncation: shrink cpu until it fits. We never broadcast
    // a memo that would be rejected on-chain.
    const overflow = bytes - MEMO_MAX_BYTES;
    compact.cpu = compact.cpu.slice(0, Math.max(0, compact.cpu.length - overflow - 1));
    return `${MEMO_PREFIX}${JSON.stringify(compact)}`;
  }
  return memo;
}

/**
 * Publish the specs:v1 memo for a node: one SPL Memo instruction signed by
 * the node key (its on-chain owner). No transfer — the fee is the only cost.
 * Detection rule on any explorer: signer == node owner, memo starts
 * `specs:v1:`. Persists the signature and surfaces an Activity event.
 */
export async function publishNodeSpecs(
  nodeId: string,
  opts: { force?: boolean } = {},
): Promise<{ ok: boolean; txHash?: string; error?: string }> {
  const node = await getNode(nodeId);
  if (!node) return { ok: false, error: 'Node not found' };
  if (!opts.force && node.specsTxHash) return { ok: true, txHash: node.specsTxHash };

  let snapshot: NodeSpecsSnapshot | undefined = node.specs;
  if (!snapshot) {
    try {
      if (node.target === 'local') {
        snapshot = await captureLocalSpecs();
      } else {
        const creds = getSSH(nodeId);
        if (!creds) return { ok: false, error: 'No SSH credentials cached for this remote node — cannot probe specs.' };
        snapshot = await captureRemoteSpecs(creds);
      }
      await updateNode(nodeId, { specs: snapshot });
    } catch (probeErr) {
      const msg = (probeErr as Error).message ?? 'unknown';
      log.warn('specs probe failed', { nodeId, err: msg });
      return { ok: false, error: `specs probe failed: ${msg}` };
    }
  }

  const memo = buildSpecsMemo(snapshot);
  try {
    const kp = await nodeKeypair(nodeId);
    if (kp.publicKey.toBase58() !== node.operatorAddress) {
      throw new Error(`node key ${kp.publicKey.toBase58()} does not match the stored owner ${node.operatorAddress}`);
    }
    const res = await sendTx([memoInstruction(memo, kp.publicKey)], kp, [], 'specs memo');
    await updateNode(nodeId, { specsTxHash: res.signature, specsPublishedAt: Date.now(), specsPublishPending: false });
    await addEvent({
      kind: 'specs-reported',
      title: `Specs reported on-chain: ${node.moniker}`,
      subtitle: `${snapshot.c} cores · ${snapshot.r} MiB RAM · ${snapshot.cpu}`.slice(0, 180),
      relatedNodeId: nodeId,
      txHash: res.signature,
    });
    return { ok: true, txHash: res.signature };
  } catch (err) {
    const errMsg = (err as Error).message;
    await updateNode(nodeId, { specsPublishPending: true });
    await addEvent({ kind: 'specs-publish-failed', title: `Specs publish failed: ${node.moniker}`, subtitle: errMsg.slice(0, 180), relatedNodeId: nodeId });
    return { ok: false, error: errMsg };
  }
}

/** Read back the most recent specs:v1 memo the node key published (explorer-independent check). */
export async function readPublishedSpecs(nodeId: string): Promise<{ signature: string; memo: string } | null> {
  const node = await getNode(nodeId);
  if (!node) return null;
  const conn = await connection();
  const sigs = await withRetry(() => conn.getSignaturesForAddress(new PublicKey(node.operatorAddress), { limit: 25 }), 'getSignaturesForAddress');
  for (const s of sigs) {
    if (s.memo && s.memo.includes(MEMO_PREFIX)) return { signature: s.signature, memo: s.memo };
  }
  return null;
}


/**
 * Replay specs publishing on app startup for any nodes flagged as
 * `specsPublishPending`. Sequential with a small delay so we don't bombard
 * the RPC pool from a fleet that came back online together.
 */
export async function replayPendingSpecs(): Promise<void> {
  const store = await readStore();
  // A node is "pending" when a publish attempt failed (specsPublishPending
  // true) — regardless of an older specsTxHash. force=true so the idempotency
  // short-circuit in publishNodeSpecs does not no-op the retry.
  const candidates: DeployedNode[] = store.nodes.filter(
    (n) => n.specsPublishPending,
  );
  if (candidates.length === 0) return;
  log.info('replaying pending specs publishes', { count: candidates.length });
  for (const node of candidates) {
    try {
      const res = await publishNodeSpecs(node.id, { force: true });
      if (!res.ok) {
        log.warn('specs replay still pending', { nodeId: node.id, err: res.error?.slice(0, 160) });
      }
    } catch (err) {
      log.warn('specs replay threw', { nodeId: node.id, err: (err as Error).message });
    }
    // Keep the cadence gentle — chain-test guidance is 7s between TXs.
    await new Promise((r) => setTimeout(r, 7_000));
  }
}

// Test hook
export const _internals = { buildSpecsMemo, MEMO_PREFIX, MEMO_MAX_BYTES };
