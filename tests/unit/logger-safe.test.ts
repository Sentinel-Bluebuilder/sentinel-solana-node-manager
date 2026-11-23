import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// ─── NM032 rc5: app.log went silent mid-run ───
// A log line whose details could not be turned into JSON (a BigInt chain amount, a circular object)
// threw inside the winston format, which broke the logger for good: every later line was lost.

const DIR = mkdtempSync(path.join(os.tmpdir(), 'snm-log-'));
vi.mock('electron', () => ({ app: { getPath: () => DIR, isPackaged: true } }));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const settle = () => new Promise((r) => setTimeout(r, 300));

describe('logger survives details JSON cannot hold', () => {
  it('safeJson: BigInt as text, circular marked, never throws', async () => {
    const { safeJson } = await import('../../src/main/services/logger');
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    expect(safeJson({ lamports: 5n })).toBe('{"lamports":"5"}');
    expect(safeJson(loop)).toBe('{"a":1,"self":"[circular]"}');
  });

  it('a BigInt line and a circular line do not stop the lines after them', async () => {
    const { log } = await import('../../src/main/services/logger');
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    log.info('line with bigint', { revenue: 12n });
    log.info('line with a loop', { loop });
    log.info('line after both', { ok: true });
    await settle();
    const text = readFileSync(path.join(DIR, 'logs', 'app.log'), 'utf8');
    expect(text).toContain('line with bigint {"revenue":"12"}');
    expect(text).toContain('line after both');
  });
});
