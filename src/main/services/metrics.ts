import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { log } from './logger';
import type { MetricsSample, MetricsWindow } from '../../shared/types';

/**
 * SQLite-backed time-series of per-node samples.
 *
 *   schema: node_samples(
 *     node_id TEXT, ts INTEGER, peers INTEGER, bytes_in INTEGER,
 *     bytes_out INTEGER, earnings_udvpn INTEGER, chain_height INTEGER,
 *     reachable INTEGER)
 *
 * Inserts happen once per minute per node via the poller in poller.ts. The
 * renderer queries `history(nodeId, '24h')` and renders it via BarChart.
 */

let db: Database.Database | null = null;
let dbFailed = false;

function getDB(): Database.Database | null {
  if (db) return db;
  if (dbFailed) return null;
  try {
    const dir = path.join(app.getPath('userData'), 'metrics');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'metrics.sqlite');
    const instance = new Database(file);
    instance.pragma('journal_mode = WAL');
    instance.exec(`
      CREATE TABLE IF NOT EXISTS node_samples (
        node_id         TEXT    NOT NULL,
        ts              INTEGER NOT NULL,
        peers           INTEGER NOT NULL DEFAULT 0,
        bytes_in        INTEGER NOT NULL DEFAULT 0,
        bytes_out       INTEGER NOT NULL DEFAULT 0,
        earnings_udvpn  INTEGER NOT NULL DEFAULT 0,
        chain_height    INTEGER,
        reachable       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (node_id, ts)
      );
      CREATE INDEX IF NOT EXISTS idx_samples_node_ts ON node_samples(node_id, ts DESC);
    `);
    db = instance;
    return db;
  } catch (err) {
    dbFailed = true;
    log.error('metrics DB unavailable — disabling time-series', {
      err: (err as Error).message,
      hint: 'Run `npm run rebuild:electron` (dev) or reinstall the app (packaged).',
    });
    return null;
  }
}

export function recordSample(sample: MetricsSample): void {
  const handle = getDB();
  if (!handle) return; // disabled (sqlite bindings unavailable)
  try {
    const stmt = handle.prepare(
      `INSERT OR REPLACE INTO node_samples
        (node_id, ts, peers, bytes_in, bytes_out, earnings_udvpn, chain_height, reachable)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      sample.nodeId,
      sample.ts,
      sample.peers,
      sample.bytesIn,
      sample.bytesOut,
      sample.earningsUdvpn,
      sample.chainHeight ?? null,
      sample.reachable ? 1 : 0,
    );
  } catch (err) {
    log.debug('metrics insert failed', { err: (err as Error).message });
  }
}

/** Drop all samples for a node (called when the node is removed). */
export function purgeNode(nodeId: string): void {
  const handle = getDB();
  if (!handle) return;
  try {
    handle.prepare('DELETE FROM node_samples WHERE node_id = ?').run(nodeId);
  } catch (err) {
    log.debug('metrics purge failed', { err: (err as Error).message });
  }
}

export function history(nodeId: string, window: MetricsWindow): MetricsSample[] {
  const handle = getDB();
  if (!handle) return [];
  const windowMs = windowToMs(window);
  const since = Date.now() - windowMs;
  const rows = handle
    .prepare(
      `SELECT node_id, ts, peers, bytes_in, bytes_out, earnings_udvpn, chain_height, reachable
       FROM node_samples
       WHERE node_id = ? AND ts >= ?
       ORDER BY ts ASC`,
    )
    .all(nodeId, since) as Array<{
    node_id: string;
    ts: number;
    peers: number;
    bytes_in: number;
    bytes_out: number;
    earnings_udvpn: number;
    chain_height: number | null;
    reachable: number;
  }>;

  return rows.map((r) => ({
    nodeId: r.node_id,
    ts: r.ts,
    peers: r.peers,
    bytesIn: r.bytes_in,
    bytesOut: r.bytes_out,
    earningsUdvpn: r.earnings_udvpn,
    chainHeight: r.chain_height ?? undefined,
    reachable: Boolean(r.reachable),
  }));
}

function windowToMs(window: MetricsWindow): number {
  switch (window) {
    case '1h':
      return 60 * 60 * 1000;
    case '24h':
      return 24 * 60 * 60 * 1000;
    case '7d':
      return 7 * 24 * 60 * 60 * 1000;
    case '30d':
      return 30 * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Invalid metrics window: ${String(window)}`);
  }
}
