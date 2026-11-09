import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { readStore } from './store';
import { getSettings, redactSettings } from './settings';
import { logDir, log } from './logger';
import type { NodeLogExportRequest } from '../../shared/types';

/**
 * Diagnostics bundle shared by the GUI (save dialog) and the CLI (temp dir):
 * sanitized store (no key backups, no secrets), redacted settings (no RPC API
 * keys), build meta, app logs. Never anything a user would regret sharing.
 */
export async function writeDiagnosticsZip(targetZip: string): Promise<void> {
  const store = await readStore();
  const sanitizedStore = {
    wallet: store.wallet ? { address: store.wallet.address, createdAt: store.wallet.createdAt, secretKind: store.wallet.secretKind } : null,
    nodes: store.nodes.map((n) => ({
      id: n.id,
      moniker: n.moniker,
      target: n.target,
      status: n.status,
      operatorAddress: n.operatorAddress,
      nodePda: n.nodePda,
      serviceType: n.serviceType,
      removalStage: n.removalStage,
      createdAt: n.createdAt,
      host: n.host,
      port: n.port,
    })),
    testChannels: store.testChannels ?? [],
    eventsLast50: store.events.slice(0, 50),
  };
  const settings = await getSettings();
  const zip = new AdmZip();
  zip.addFile(
    'meta.json',
    Buffer.from(
      JSON.stringify(
        {
          version: app.getVersion(),
          platform: process.platform,
          arch: process.arch,
          electron: process.versions.electron,
          node: process.versions.node,
          chromium: process.versions.chrome,
          ts: new Date().toISOString(),
        },
        null,
        2,
      ),
    ),
  );
  zip.addFile('store.json', Buffer.from(JSON.stringify(sanitizedStore, null, 2)));
  zip.addFile('settings.json', Buffer.from(JSON.stringify(redactSettings(settings), null, 2)));
  try {
    for (const f of await fs.readdir(logDir())) zip.addFile(`logs/${f}`, await fs.readFile(path.join(logDir(), f)));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('diagnostics: log dir unreadable', { err: (err as Error).message });
  }
  zip.writeZip(targetZip);
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\[[0-9]{1,3}(?:;[0-9]{1,3})*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** Parse one dvpnd / docker log line: JSON lines first, then "ts level msg k=v" text. */
export function parseLineForJson(raw: string): {
  raw: string;
  timestamp: string | null;
  level: string | null;
  message: string;
  fields: Record<string, string>;
} {
  const line = stripAnsi(raw).replace(/\s+$/u, '');
  if (line.startsWith('{')) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj)) if (!['time', 'level', 'message', 'msg'].includes(k)) fields[k] = typeof v === 'string' ? v : JSON.stringify(v);
      return {
        raw,
        timestamp: typeof obj.time === 'string' ? obj.time : null,
        level: typeof obj.level === 'string' ? obj.level.toUpperCase() : null,
        message: String(obj.message ?? obj.msg ?? ''),
        fields,
      };
    } catch (err) {
      log.debug('log line looked like JSON but is not', { err: (err as Error).message });
    }
  }
  let timestamp: string | null = null;
  let rest = line;
  const tsMatch = rest.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+(.*)$/u);
  if (tsMatch) {
    timestamp = tsMatch[1];
    rest = tsMatch[2];
  }
  let level: string | null = null;
  const lvlMatch = rest.match(/^\[?(ERROR|ERR|WARN(?:ING)?|INFO|INF|DEBUG|DBG|TRACE|TRC|FATAL|FTL)\]?[:\s]\s*(.*)$/iu);
  if (lvlMatch) {
    level = lvlMatch[1].toUpperCase();
    rest = lvlMatch[2];
  }
  const fields: Record<string, string> = {};
  const kvRe = /([A-Za-z_][\w.-]*)=("(?:[^"\\]|\\.)*"|\[[^\]]*\]|\S+)/g;
  let firstIdx = -1;
  let m: RegExpExecArray | null;
  while ((m = kvRe.exec(rest))) {
    if (firstIdx < 0) firstIdx = m.index;
    let value = m[2];
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    fields[m[1]] = value;
  }
  const message = firstIdx < 0 ? rest.trim() : rest.slice(0, firstIdx).trim();
  return { raw, timestamp, level, message, fields };
}

/** File body for a node log export (same for GUI and CLI). */
export function renderLogExport(req: NodeLogExportRequest, moniker: string | null): string {
  if (req.format === 'json') {
    const parsed = req.lines.map(parseLineForJson);
    return JSON.stringify({ nodeId: req.nodeId, moniker, exportedAt: new Date().toISOString(), lineCount: parsed.length, lines: parsed }, null, 2);
  }
  return req.lines.map((l) => stripAnsi(l).replace(/\s+$/u, '')).join('\n') + '\n';
}
